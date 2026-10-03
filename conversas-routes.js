/**
 * conversas-routes.js — central de conversas do módulo Comunicação.
 *
 * A unidade aqui é a CONVERSA, não a mensagem enfileirada. É essa troca que
 * torna o módulo operável: uma conversa tem estado (aberta, pendente,
 * resolvida), dono, etiquetas e um contato do ERP do outro lado — então dá
 * para saber o que falta responder, quem responde e o que já foi resolvido.
 *
 * As mensagens continuam vindo de whatsapp_messages (gravadas pelo webhook).
 * A conversa é derivada delas na primeira vez que aparece e mantida daí em
 * diante — nada de reprocessar histórico a cada abertura de tela.
 *
 * Também vive aqui a base de conhecimento da IA: pedaços com origem e data,
 * e as correções que o atendente faz quando o robô erra. É assim que se
 * "treina" um atendente de IA — com o caso que ele errou virando base, não
 * com prompt novo.
 */

const { reentrarContextoTenant } = require('./tenant-middleware');

const ESTADOS = ['aberta', 'pendente', 'resolvida'];

function migrarConversasDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conv_conversas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canal TEXT NOT NULL DEFAULT 'whatsapp',
      jid TEXT NOT NULL,
      telefone TEXT,
      nome TEXT,
      pessoaId INTEGER,
      estado TEXT NOT NULL DEFAULT 'aberta',
      donoId INTEGER,
      etiquetas TEXT,
      naoLidas INTEGER NOT NULL DEFAULT 0,
      iaAtiva INTEGER NOT NULL DEFAULT 1,
      ultimaMensagem TEXT,
      ultimaEm TEXT,
      primeiraRespostaEm TEXT,
      resolvidaEm TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      pedidoId INTEGER,
      oportunidadeId INTEGER,
      -- O número de WhatsApp da conversa (whatsapp_canais). Uma conversa por
      -- contato E número desde 28/09; 0 = de antes de haver número cadastrado.
      canalId INTEGER NOT NULL DEFAULT 0,
      UNIQUE(canal, jid, canalId)
    );
    CREATE INDEX IF NOT EXISTS idx_conv_estado ON conv_conversas(estado, ultimaEm DESC);
    CREATE INDEX IF NOT EXISTS idx_conv_pessoa ON conv_conversas(pessoaId);

    CREATE TABLE IF NOT EXISTS conv_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversaId INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      detalhe TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_conv_ev ON conv_eventos(conversaId, id DESC);

    -- Base da IA em pedaços: cada um com origem e data, para a resposta poder
    -- dizer de onde veio e para o texto velho ser encontrável e corrigível.
    CREATE TABLE IF NOT EXISTS ia_base (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo TEXT NOT NULL,
      conteudo TEXT NOT NULL,
      origem TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      usos INTEGER NOT NULL DEFAULT 0,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- O robô errou, o atendente escreveu a certa: vira item de base e fica
    -- registrado para medir se o erro voltou.
    CREATE TABLE IF NOT EXISTS ia_correcoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversaId INTEGER,
      perguntou TEXT,
      respondeu TEXT,
      correta TEXT NOT NULL,
      viraBase INTEGER NOT NULL DEFAULT 1,
      baseId INTEGER,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const alterSafe = (sql) => {
    try { db.exec(sql); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  };
  // O funil é o do CRM (crm_funis / crm_etapas / crm_oportunidades), que já
  // existe, está em uso e é mais completo — tem probabilidade, motivo de perda,
  // geração de OS e atividades. A conversa aponta para a oportunidade de lá em
  // vez de manter um funil próprio: dois quadros seriam duas verdades sobre a
  // mesma venda.
  alterSafe('ALTER TABLE conv_conversas ADD COLUMN oportunidadeId INTEGER');
  alterSafe('ALTER TABLE conv_conversas ADD COLUMN pedidoId INTEGER');
  // Tabela de antes dos vários números: reconstrói com o número na chave. A
  // migração de verdade roda no boot (db-schema.js); isto cobre a tabela que
  // nasceu depois dele. Idempotente, e barato quando já está feito.
  const canais = require('./whatsapp-canais');
  canais.criarTabela(db);
  const padrao = canais.canalPadrao(db);
  canais.reconstruirConversas(db, padrao && padrao.id);
  db.exec('CREATE INDEX IF NOT EXISTS idx_conv_canal ON conv_conversas(canalId)');

  // Antes só se registrava o erro, então a tabela media meia verdade: dava para
  // saber quantas vezes o robô errou, nunca quantas acertou. O veredito 'certo'
  // é um voto sem resposta nova — não vira item de base, porque acerto quer
  // dizer que a base já estava boa naquele ponto.
  alterSafe("ALTER TABLE ia_correcoes ADD COLUMN veredito TEXT NOT NULL DEFAULT 'errado'");
  // Sem saber a qual mensagem o voto se refere, o atendente reabre a conversa
  // e não enxerga por onde já passou — inviável em histórico grande.
  alterSafe('ALTER TABLE ia_correcoes ADD COLUMN mensagemId INTEGER');
}

const jsonOu = (t, p) => { try { return t ? JSON.parse(t) : p; } catch { return p; } };
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

const temTabela = (db, t) => {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t); }
  catch { return false; }
};

/**
 * As mensagens (`m`) de uma conversa (`c`): do mesmo contato E que passaram
 * pela instância do número dela. A mesma pessoa falando com dois números são
 * duas conversas (decisão de 28/09). Conversa de antes de haver número
 * cadastrado (canalId 0) fica com todas as mensagens do contato, como antes.
 */
const MSG_DA_CONVERSA = `m.remote_jid = c.jid AND (c.canalId = 0
   OR m.instance = (SELECT w.instance FROM whatsapp_canais w WHERE w.id = c.canalId))`;

/** Quantas mensagens a tela recebe de uma vez. Mais antigas, por demanda. */
const MSGS_POR_VEZ = 400;

/**
 * As mensagens de uma conversa, em ordem cronológica. Com `antesDe`, o pedaço
 * anterior a essa mensagem: é como a tela busca o histórico de conversa longa,
 * que antes era cortado em 400 sem aviso nenhum.
 */
function mensagensDaConversa(db, c, { antesDe = null } = {}) {
  const corte = antesDe ? ' AND m.id < ?' : '';
  const args = [c.jid, c.canalId || 0, ...(antesDe ? [Number(antesDe)] : []), MSGS_POR_VEZ];
  return db.prepare(`SELECT * FROM (
      SELECT m.id, m.from_me, m.from_bot, m.texto, m.message_type, m.timestamp, m.apagadaEm,
        m.editadaEm, m.wa_message_id,
        (SELECT veredito FROM ia_correcoes x WHERE x.mensagemId = m.id ORDER BY x.id DESC LIMIT 1) AS veredito,
        -- O balao citado: o texto e o lado de quem escreveu a mensagem que esta
        -- responde. Vem por subconsulta pelo id do WhatsApp porque e esse id que
        -- o contextInfo do WhatsApp entrega, e nao o nosso. Citada fora das
        -- mensagens guardadas devolve NULL, e a tela mostra a resposta sem o
        -- balao, em vez de um vazio com borda.
        (SELECT q.texto FROM whatsapp_messages q
          WHERE q.wa_message_id = m.citaWaId AND q.instance = m.instance LIMIT 1) AS citaTexto,
        (SELECT q.from_me FROM whatsapp_messages q
          WHERE q.wa_message_id = m.citaWaId AND q.instance = m.instance LIMIT 1) AS citaDeMim,
        -- As REACOES desta mensagem, juntas. Reacao e do balao reagido, e nao
        -- uma mensagem da conversa: ate 02/10 cada uma virava um balao
        -- "(sem texto)" no meio do historico (44 em 30 dias, no 1bit).
        (SELECT group_concat(r.texto, '') FROM whatsapp_messages r
          WHERE r.message_type = 'reactionMessage' AND r.citaWaId = m.wa_message_id
            AND r.instance = m.instance AND r.texto IS NOT NULL AND r.texto <> '') AS reacoes
      FROM whatsapp_messages m, (SELECT ? AS jid, ? AS canalId) c
      WHERE ${MSG_DA_CONVERSA}${corte}
        AND (m.message_type IS NULL OR m.message_type <> 'reactionMessage')
      ORDER BY m.id DESC LIMIT ?
    ) ORDER BY id ASC`).all(...args);
}

/**
 * Conversa de número REMOVIDO não aparece na caixa.
 *
 * Tirar um número em Canais não apaga nada: grava `ativo = 0`
 * (whatsapp-adapter, DELETE /api/whatsapp/canais/:id). O seletor de números
 * some junto, porque `listarCanais` só traz ativo — e as conversas daquele
 * número ficavam na lista misturadas com as do número principal, sem nome de
 * canal e sem como separá-las. No 1bit eram 9 conversas do "Suporte", removido
 * em 01/10/2026.
 *
 * A regra pergunta se o canal está INATIVO, e não se está ativo, e a diferença
 * importa: canal que não existe na tabela (banco antes da migração de canais,
 * linha apagada à mão) cairia fora com a pergunta invertida, e a caixa inteira
 * sumiria. `canalId = 0` — a conversa anterior a haver números — também fica.
 */
const CANAL_VIVO = `(c.canalId = 0 OR NOT EXISTS (SELECT 1 FROM whatsapp_canais w2
   WHERE w2.id = c.canalId AND w2.ativo = 0))`;
/** O mesmo, para as contagens, que consultam sem apelido de tabela. */
const CANAL_VIVO_SEM_ALIAS = CANAL_VIVO.replace(/\bc\.canalId\b/g, 'canalId');

/**
 * Os NICHOS que a caixa oferece: os segmentos das campanhas que de fato
 * enviaram, e não o cadastro inteiro de segmentos.
 *
 * Até 01/10/2026 o seletor listava os 9 segmentos semeados e filtrava pelo
 * `segmentoId` da FICHA — ou seja, oferecia ramo em que nunca se fez campanha e
 * recortava por um dado que ninguém preenche. Agora o nicho é o da CAMPANHA
 * (`comm_campanhas.segmentos`, o que se escolhe ao disparar), e o recorte é
 * "quem recebeu campanha deste nicho". No 1bit isso dá dois: Alimentação e
 * Beleza.
 */
function nichosComCampanha(db) {
  if (!temTabela(db, 'comm_campanhas') || !temTabela(db, 'segmentos')) return [];
  try {
    const linhas = db.prepare(`SELECT DISTINCT c.segmentos FROM comm_campanhas c
      WHERE c.segmentos IS NOT NULL AND c.segmentos <> ''
        AND EXISTS (SELECT 1 FROM comm_envios e WHERE e.campanhaId = c.id AND e.status = 'enviado')`).all();
    const ids = new Set();
    for (const l of linhas) for (const id of jsonOu(l.segmentos, [])) ids.add(Number(id));
    if (!ids.size) return [];
    return db.prepare(`SELECT id, nome FROM segmentos WHERE id IN (${[...ids].map(() => '?').join(',')})
      ORDER BY nome`).all(...ids);
  } catch { return []; }
}

/**
 * Os telefones (últimos 8 dígitos) que RECEBERAM campanha de um nicho.
 *
 * Oito dígitos pelo mesmo motivo do resto desta tela: o telefone da conversa vem
 * do jid do WhatsApp, às vezes sem o nono dígito, e o do envio é o normalizado.
 */
function sqlDoNicho(nichoId) {
  return `SELECT substr(e.destino, -8) FROM comm_envios e
    JOIN comm_campanhas c2 ON c2.id = e.campanhaId
    WHERE e.status = 'enviado' AND e.destino IS NOT NULL
      AND EXISTS (SELECT 1 FROM json_each(c2.segmentos) j WHERE CAST(j.value AS INTEGER) = ${Number(nichoId)})`;
}

/**
 * Quem recebeu a campanha do nicho e NUNCA escreveu — gente que não tem
 * conversa nenhuma, e por isso não existia na caixa.
 *
 * A pedido (01/10/2026): sem isto, o filtro "não respondeu" viria vazio, porque
 * conversa só nasce quando o contato responde. A linha é montada do próprio
 * envio (destino, mensagem que saiu e data), e `conversaId` nulo é o que diz à
 * tela que ali ainda não há conversa.
 */
function destinosSemConversa(db, nichoId, limite) {
  if (!temTabela(db, 'comm_envios')) return [];
  try {
    return db.prepare(`SELECT e.destino AS telefone, MAX(e.dataEnvio) AS ultimaEm,
        e.mensagemRenderizada AS ultimaMensagem, e.canalId,
        (SELECT ${require('./lead-ficha').nomeExibido('p')} FROM pessoas p WHERE p.id = e.pessoaId) AS pessoaNome
      FROM comm_envios e
      WHERE e.status = 'enviado' AND e.destino IS NOT NULL
        AND substr(e.destino, -8) IN (${sqlDoNicho(nichoId)})
        AND substr(e.destino, -8) NOT IN (SELECT substr(telefone, -8) FROM conv_conversas)
      GROUP BY substr(e.destino, -8)
      ORDER BY ultimaEm DESC LIMIT ?`).all(limite).map((d) => ({
      id: null, semConversa: true, canal: 'whatsapp', canalId: d.canalId || 0,
      telefone: d.telefone, nome: d.pessoaNome || null, pessoaNome: d.pessoaNome || null,
      ultimaMensagem: d.ultimaMensagem, ultimaEm: d.ultimaEm, naoLidas: 0, estado: 'aberta',
      iaAtiva: 1, donoId: null, donoNome: null, etiquetas: [],
    }));
  } catch { return []; }
}

/**
 * A mensagem `msgId` da conversa `convId`, quando ela pode receber as ações de
 * apagar e editar: tem de ser NOSSA, da própria conversa, e ter registro no
 * WhatsApp (`wa_message_id`).
 *
 * As três conferências ficam aqui, e não em cada rota, porque é a mesma regra:
 * sem a chave do WhatsApp não há o que pedir à Evolution, e mensagem do contato
 * não se apaga nem se edita — nem no aplicativo dele.
 */
function minhaMensagem(db, convId, msgId) {
  const c = db.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(convId);
  if (!c) return { erro: { status: 404, error: 'Conversa não encontrada' } };
  const m = db.prepare(`SELECT m.* FROM whatsapp_messages m, (SELECT ? AS jid, ? AS canalId) c
    WHERE ${MSG_DA_CONVERSA} AND m.id = ?`).get(c.jid, c.canalId || 0, Number(msgId));
  if (!m) return { erro: { status: 404, error: 'Mensagem não encontrada nesta conversa' } };
  if (!m.from_me) return { erro: { status: 400, error: 'Só dá para mexer nas mensagens que você enviou' } };
  if (!m.wa_message_id) return { erro: { status: 400, error: 'Esta mensagem não tem registro no WhatsApp' } };
  return { c, m };
}

/**
 * O que o envio precisa para sair como RESPOSTA a outra mensagem: a chave dela
 * no WhatsApp e o texto, que vai no balão citado.
 *
 * Citada que não existe, que é de outra conversa ou que não tem id do WhatsApp
 * devolve `null`, e a resposta sai sem citação: perder a citação é menos ruim
 * que não mandar a resposta.
 */
function citarDaMensagem(db, c, citarId) {
  if (!citarId) return null;
  try {
    const m = db.prepare(`SELECT m.wa_message_id, m.texto, m.from_me FROM whatsapp_messages m, (SELECT ? AS jid, ? AS canalId) c
      WHERE ${MSG_DA_CONVERSA} AND m.id = ?`).get(c.jid, c.canalId || 0, Number(citarId));
    if (!m || !m.wa_message_id) return null;
    return { waId: m.wa_message_id, texto: m.texto || '', fromMe: !!m.from_me, jid: c.jid };
  } catch { return null; }
}

/**
 * "Aguardando você": a última mensagem da conversa é deles.
 *
 * Não usa conv_conversas.primeiraRespostaEm — esse campo só é escrito pelo
 * registrarMensagem, e nem o disparo de campanha nem a resposta da IA passam
 * por ele (gravam direto em whatsapp_messages). No 1bit o campo aponta 817
 * conversas sem resposta onde o fato são 45.
 */
const AGUARDANDO_SQL = `(SELECT m.from_me FROM whatsapp_messages m
   WHERE ${MSG_DA_CONVERSA} ORDER BY m.id DESC LIMIT 1) = 0`;

/**
 * Subconsulta com os telefones (últimos 8 dígitos, coluna `k`) de quem RECEBEU
 * uma campanha de WhatsApp, ou de quem recebeu e RESPONDEU. Vale para as duas
 * origens desde 29/09: `campanha` é 'todas', 'wa:<id>' (legado; um número solto
 * também é legado) ou 'comm:<id>' (campanha nova).
 *
 * Últimos 8 dígitos porque o telefone da conversa vem do jid do WhatsApp, que
 * às vezes não tem o nono dígito, e o da campanha nova é o normalizado, com ele.
 * Subconsulta, e não lista de parâmetros: "receberam" nas legado do 1bit são 27
 * mil telefones.
 *
 * "Respondeu" é o fato observável, que vale para trás: chegou mensagem do lead
 * depois de a campanha ter enviado para ele. A marca wa_campanha_dest.status =
 * 'respondeu' nasceu depois dos primeiros disparos e cobria 2 das 55 respostas
 * reais do 1bit.
 */
function sqlDaCampanha(db, campanha, modo) {
  const temMsgs = temTabela(db, 'whatsapp_messages');
  const soResposta = modo !== 'receberam';
  if (soResposta && !temMsgs) return null;
  const m = /^(wa|comm):(\d+)$/.exec(campanha) || (/^\d+$/.test(campanha) ? [null, 'wa', campanha] : null);
  const origem = m ? m[1] : null, id = m ? Number(m[2]) : null;
  const partes = [], args = [];
  if (origem !== 'comm' && temTabela(db, 'wa_campanha_dest')) {
    let q = `SELECT substr(d.telefone, -8) AS k FROM wa_campanha_dest d
      WHERE d.enviado_em IS NOT NULL AND d.telefone IS NOT NULL`;
    if (id != null) { q += ' AND d.campanha_id = ?'; args.push(id); }
    if (soResposta) q += ` AND (d.status = 'respondeu' OR EXISTS (SELECT 1 FROM whatsapp_messages m
        WHERE m.from_me = 0 AND m.timestamp > strftime('%s', d.enviado_em)
          AND (m.remote_jid = d.jid OR m.remote_jid = d.telefone || '@s.whatsapp.net')))`;
    partes.push(q);
  }
  if (origem !== 'wa' && temTabela(db, 'comm_envios')) {
    let q = `SELECT substr(e.destino, -8) AS k FROM comm_envios e
      WHERE e.canal = 'whatsapp' AND e.status = 'enviado' AND e.destino IS NOT NULL`;
    if (id != null) { q += ' AND e.campanhaId = ?'; args.push(id); }
    if (soResposta) q += ` AND EXISTS (SELECT 1 FROM whatsapp_messages m
        WHERE m.from_me = 0 AND m.timestamp > strftime('%s', e.dataEnvio)
          AND substr(replace(m.remote_jid, '@s.whatsapp.net', ''), -8) = substr(e.destino, -8))`;
    partes.push(q);
  }
  if (!partes.length) return null;
  return { sql: partes.join(' UNION '), args };
}

/**
 * Casa o número da conversa com uma pessoa do cadastro. Sem isso o atendente
 * fica olhando um telefone solto, quando o sistema já sabe quem é, o que a
 * pessoa comprou e o que ela deve.
 */
function acharPessoa(db, telefone) {
  const t = soDigitos(telefone);
  if (t.length < 8) return null;
  const fim = t.slice(-8);   // ignora DDI/DDD e o nono dígito, que variam no cadastro
  try {
    const r = db.prepare(`SELECT id, ${require('./lead-ficha').nomeExibido('pessoas')} AS razaoSocial FROM pessoas
      WHERE ativo = 1 AND replace(replace(replace(replace(COALESCE(telefone,''),'(',''),')',''),'-',''),' ','') LIKE ?
      LIMIT 1`).get('%' + fim);
    return r || null;
  } catch { return null; }
}

/**
 * Garante que existe conversa para o jid e devolve o id. Chamado tanto pela
 * tela quanto pelo webhook — por isso é idempotente.
 */
function garantirConversa(db, { jid, nome = null, canal = 'whatsapp', canalId = 0 }) {
  migrarConversasDB(db);
  const existente = db.prepare('SELECT id, pessoaId FROM conv_conversas WHERE canal = ? AND jid = ? AND canalId = ?')
    .get(canal, jid, canalId || 0);
  if (existente) {
    if (!existente.pessoaId) {
      const p = acharPessoa(db, jid.split('@')[0]);
      if (p) db.prepare('UPDATE conv_conversas SET pessoaId = ?, nome = COALESCE(nome, ?) WHERE id = ?')
        .run(p.id, p.razaoSocial, existente.id);
    }
    return existente.id;
  }
  const telefone = jid.split('@')[0];
  const p = acharPessoa(db, telefone);
  return db.prepare(`INSERT INTO conv_conversas (canal, jid, telefone, nome, pessoaId, estado, canalId)
    VALUES (?, ?, ?, ?, ?, 'aberta', ?)`)
    .run(canal, jid, telefone, p ? p.razaoSocial : (nome || null), p ? p.id : null, canalId || 0).lastInsertRowid;
}

/** Chamado quando chega ou sai mensagem: mantém o resumo da conversa em dia. */
function registrarMensagem(db, { jid, texto, deMim, nome = null, canalId = 0 }) {
  try {
    const id = garantirConversa(db, { jid, nome, canalId });
    db.prepare(`UPDATE conv_conversas SET
        ultimaMensagem = ?, ultimaEm = CURRENT_TIMESTAMP,
        nome = COALESCE(nome, ?),
        naoLidas = CASE WHEN ? = 1 THEN 0 ELSE naoLidas + 1 END,
        estado = CASE WHEN ? = 1 THEN estado ELSE 'aberta' END,
        primeiraRespostaEm = CASE WHEN ? = 1 AND primeiraRespostaEm IS NULL
                                  THEN CURRENT_TIMESTAMP ELSE primeiraRespostaEm END
      WHERE id = ?`)
      .run(String(texto || '').slice(0, 300), nome, deMim ? 1 : 0, deMim ? 1 : 0, deMim ? 1 : 0, id);
    return id;
  } catch { return null; }
}

// Sincroniza conversas a partir das mensagens que já existem.
//
// INCREMENTAL pelo id da mensagem (03/10/2026). O cursor fica em
// `config.conv_sync_ultima_msg` e diz até onde já se olhou; a varredura começa
// dali. Até então o comentário daqui dizia "só olha o que entrou depois da
// última conversa" e o código reagrupava `whatsapp_messages` INTEIRA em cada
// carregamento da caixa: 143 ms dos 250 ms do `GET /api/conversas` no 1bit, com
// 42 mil mensagens, em cada ação do atendente e a cada polling de 30 s de cada
// aba aberta. A primeira passada depois de subir faz o trabalho completo, uma
// vez só.
//
// As subconsultas de `ultimo` e `nome` continuam olhando o histórico TODO do
// contato, e isso é de propósito: a última mensagem com texto e o último
// push_name recebido podem estar atrás do cursor.
//
// Conversa apagada à mão não renasce enquanto o cursor estiver à frente dela.
// Para reconstruir: `DELETE FROM config WHERE chave = 'conv_sync_ultima_msg'`.
//
// Agrupa por contato E instância: cada número tem as suas conversas. Mensagem
// de instância que não é número cadastrado fica com o padrão.
function sincronizar(db) {
  migrarConversasDB(db);
  const canais = require('./whatsapp-canais');
  const porInstancia = new Map(canais.listarCanais(db, { incluirInativos: true }).map(c => [c.instance, c.id]));
  const padrao = canais.canalPadrao(db);
  let grupos = [];
  let cursor = 0;
  let ate = 0;
  try {
    cursor = Number(db.prepare("SELECT valor FROM config WHERE chave = 'conv_sync_ultima_msg'").get()?.valor) || 0;
    ate = db.prepare('SELECT MAX(id) m FROM whatsapp_messages').get().m || 0;
    // Nada entrou desde a última passada: é o caso comum, e custa uma consulta.
    if (ate <= cursor) return 0;
    grupos = db.prepare(`SELECT remote_jid jid, instance,
        MAX(timestamp) ts,
        (SELECT texto FROM whatsapp_messages x WHERE x.remote_jid = m.remote_jid AND x.instance IS m.instance
           AND texto IS NOT NULL ORDER BY id DESC LIMIT 1) ultimo,
        -- Só de mensagem RECEBIDA: no que sai, o push_name é o do dono da
        -- instância, e a conversa acabava batizada com o nome de quem atende.
        (SELECT push_name FROM whatsapp_messages x WHERE x.remote_jid = m.remote_jid AND x.instance IS m.instance
           AND x.from_me = 0 AND push_name IS NOT NULL ORDER BY id DESC LIMIT 1) nome
      FROM whatsapp_messages m WHERE remote_jid IS NOT NULL AND remote_jid <> 'status@broadcast'
        AND remote_jid NOT LIKE '%@g.us' AND m.id > ?
      GROUP BY remote_jid, instance
      -- Conversa nasce de quem ESCREVEU. Desde 30/09 o que o sistema envia
      -- também é gravado (para a tela e a IA verem o que foi oferecido), e sem
      -- este filtro uma campanha de 27 mil contatos viraria 27 mil conversas na
      -- primeira vez que alguém abrisse a tela. Quem só recebeu fica com a
      -- mensagem guardada, e a conversa aparece inteira quando ele responder.
      HAVING SUM(CASE WHEN m.from_me = 0 THEN 1 ELSE 0 END) > 0`).all(cursor);
  } catch { return 0; }

  let novas = 0;
  for (const j of grupos) {
    const canalId = porInstancia.get(j.instance) || (padrao ? padrao.id : 0);
    const antes = db.prepare('SELECT id FROM conv_conversas WHERE canal = ? AND jid = ? AND canalId = ?')
      .get('whatsapp', j.jid, canalId);
    if (!antes) {
      const id = garantirConversa(db, { jid: j.jid, nome: j.nome, canalId });
      db.prepare(`UPDATE conv_conversas SET ultimaMensagem = ?, nome = COALESCE(nome, ?),
          ultimaEm = datetime(?, 'unixepoch') WHERE id = ?`)
        .run(String(j.ultimo || '').slice(0, 300), j.nome, j.ts || Math.floor(Date.now() / 1000), id);
      novas++;
    }
  }
  // O cursor avança DEPOIS do laço: erro no meio tem de reprocessar a janela na
  // próxima passada, e não saltá-la deixando conversa sem nascer.
  db.prepare(`INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao)
    VALUES ('conv_sync_ultima_msg', ?, CURRENT_TIMESTAMP)`).run(String(ate));
  return novas;
}

function registrarRotasConversas(app, db) {
  migrarConversasDB(db);

  const usuario = (req) => req.session?.username || null;
  const evento = (conversaId, tipo, detalhe, req) => {
    try {
      db.prepare('INSERT INTO conv_eventos (conversaId, tipo, detalhe, usuario) VALUES (?,?,?,?)')
        .run(conversaId, tipo, detalhe || null, usuario(req));
    } catch { /* histórico é bônus, não pode derrubar a ação */ }
  };

  // ---------- lista ----------
  app.get('/api/conversas', (req, res) => {
    try {
      sincronizar(db);
      const estado = String(req.query.estado || '');
      const q = String(req.query.q || '').trim().toLowerCase();
      const recorte = String(req.query.recorte || '');   // naoLidas | aguardando
      const temMensagens = temTabela(db, 'whatsapp_messages');
      // 'todas', 'wa:<id>' ou 'comm:<id>'; vazio desliga o recorte. `modo`:
      // quem respondeu (padrão) ou quem recebeu.
      const campanha = String(req.query.campanha || '');
      const modo = req.query.modo === 'receberam' ? 'receberam' : 'responderam';
      // Sempre calculado, esteja o filtro ligado ou não: é ele que alimenta a
      // contagem do próprio botão que o liga.
      const daCampanha = sqlDaCampanha(db, campanha || 'todas', modo);

      // Quem está pedindo. Vale para o recorte 'minhas' e para nada mais: dono é
      // organização de fila, não permissão — todo atendente continua vendo tudo.
      const usuarioId = Number(req.user?.id) || null;

      let sql = `SELECT c.*, ${require('./lead-ficha').nomeExibido('p')} AS pessoaNome,
          COALESCE(NULLIF(u.nome, ''), u.username) AS donoNome, w.nome AS canalNome,
          ${temMensagens ? SQL_IA_PAUSADA : '0'} AS iaPausada
        FROM conv_conversas c
        LEFT JOIN pessoas p ON p.id = c.pessoaId
        LEFT JOIN users u ON u.id = c.donoId
        LEFT JOIN whatsapp_canais w ON w.id = c.canalId`;
      const onde = [];
      const args = [];
      // Filtro por número: a caixa é uma só, e este recorte vale também para
      // as contagens abaixo, senão o número do botão não bateria com a lista.
      const canalFiltro = Number(req.query.canal) || null;
      // NICHO: o segmento da CAMPANHA que a pessoa recebeu (01/10/2026), e não
      // mais o `segmentoId` da ficha.
      const nicho = Number(req.query.nicho) || null;
      // A SITUAÇÃO da conversa, num seletor só (02/10): respondeu, não
      // respondeu, e o resultado do roteiro, que antes eram chips à parte.
      // Vale com ou sem nicho — sem ele, recorta a caixa inteira.
      const SITUACOES = ['responderam', 'naoResponderam', 'qualificados', 'desqualificados'];
      const situacao = SITUACOES.includes(String(req.query.situacao || ''))
        ? String(req.query.situacao) : 'todos';
      // Número removido em Canais não enche mais a caixa (ver CANAL_VIVO).
      const soCanal = (canalFiltro ? ` AND canalId = ${canalFiltro}` : '')
        + ` AND ${CANAL_VIVO_SEM_ALIAS}`;
      onde.push(CANAL_VIVO);
      if (canalFiltro) { onde.push('c.canalId = ?'); args.push(canalFiltro); }
      if (nicho) onde.push(`substr(c.telefone, -8) IN (${sqlDoNicho(nicho)})`);
      if (ESTADOS.includes(estado)) { onde.push('c.estado = ?'); args.push(estado); }
      if (recorte === 'naoLidas') onde.push('c.naoLidas > 0');
      if (recorte === 'aguardando' && temMensagens) onde.push(AGUARDANDO_SQL);
      // Sem usuário identificado, 'minhas' devolve NADA. Cair para "todas" seria
      // pior que o erro: o atendente veria a fila inteira acreditando que é a
      // dele, e responderia conversa que outro já assumiu.
      if (recorte === 'minhas') {
        if (usuarioId) { onde.push('c.donoId = ?'); args.push(usuarioId); } else onde.push('0');
      }
      if (recorte === 'semDono') onde.push('c.donoId IS NULL');
      // O recorte `semResposta` SAIU em 01/10/2026, e o motivo é o número que
      // ele mostrava: `primeiraRespostaEm` só é escrito pelo `registrarMensagem`,
      // e nem a campanha nem a resposta da IA passam por lá. No 1bit ele dizia
      // 749 conversas sem resposta onde o fato eram 75 — e essas 75 já estavam
      // dentro das 377 de "Aguardando você", que mede o fato observável.
      // Resultado do roteiro de qualificação da campanha (roteiro-conversa.js).
      const temRoteiro = temTabela(db, 'roteiro_visitas')
        && db.prepare('PRAGMA table_info(roteiro_visitas)').all().some(x => x.name === 'resultado');
      const DO_ROTEIRO = (r) => `c.id IN (SELECT conversaId FROM roteiro_visitas WHERE resultado = '${r}')`;
      if (situacao === 'qualificados' || situacao === 'desqualificados') {
        onde.push(temRoteiro ? DO_ROTEIRO(situacao === 'qualificados' ? 'qualificado' : 'desqualificado') : '0');
      }
      if (campanha) {
        if (!daCampanha) onde.push('0');
        else { onde.push(`substr(c.telefone, -8) IN (${daCampanha.sql})`); args.push(...daCampanha.args); }
      }
      if (onde.length) sql += ' WHERE ' + onde.join(' AND ');
      sql += ' ORDER BY c.ultimaEm DESC NULLS LAST, c.id DESC LIMIT 300';
      let linhas = db.prepare(sql).all(...args);

      // Dentro de um nicho, "quem só recebeu" também aparece: são os que nunca
      // escreveram, e por isso não têm conversa. Fora do nicho isso não existe —
      // a caixa inteira viraria a lista de destinos das campanhas, que no 1bit
      // são 27 mil telefones.
      if (nicho && (situacao === 'todos' || situacao === 'naoResponderam')) {
        linhas = linhas.concat(destinosSemConversa(db, nicho, 300 - linhas.length));
        linhas.sort((a, b) => String(b.ultimaEm || '').localeCompare(String(a.ultimaEm || '')));
      }
      if ((situacao === 'responderam' || situacao === 'naoResponderam') && temMensagens) {
        // Respondeu = existe mensagem DELES. É o fato observável, o mesmo de
        // "Aguardando você", e não o campo `primeiraRespostaEm`, que mentia.
        const escreveu = db.prepare(
          'SELECT 1 FROM whatsapp_messages m WHERE m.remote_jid = ? AND m.from_me = 0 LIMIT 1');
        const respondeu = (c) => !!(c.id && c.jid && escreveu.get(c.jid));
        linhas = linhas.filter((c) => (situacao === 'responderam' ? respondeu(c) : !respondeu(c)));
      }
      if (q) linhas = linhas.filter(c => [c.nome, c.pessoaNome, c.telefone, c.ultimaMensagem]
        .some(v => String(v || '').toLowerCase().includes(q)));

      const contagem = {};
      for (const e of ESTADOS) {
        contagem[e] = db.prepare(`SELECT COUNT(*) n FROM conv_conversas WHERE estado = ?${soCanal}`).get(e).n;
      }
      contagem.total = db.prepare(`SELECT COUNT(*) n FROM conv_conversas WHERE 1${soCanal}`).get().n;
      contagem.naoLidas = db.prepare(`SELECT COUNT(*) n FROM conv_conversas WHERE naoLidas > 0${soCanal}`).get().n;
      contagem.aguardando = temMensagens
        ? db.prepare(`SELECT COUNT(*) n FROM conv_conversas c WHERE ${AGUARDANDO_SQL}${soCanal}`).get().n : 0;
      contagem.minhas = usuarioId
        ? db.prepare(`SELECT COUNT(*) n FROM conv_conversas WHERE donoId = ?${soCanal}`).get(usuarioId).n : 0;
      contagem.semDono = db.prepare(`SELECT COUNT(*) n FROM conv_conversas WHERE donoId IS NULL${soCanal}`).get().n;
      if (temRoteiro) {
        const doResultado = (r) => db.prepare(`SELECT COUNT(*) n FROM conv_conversas c WHERE ${DO_ROTEIRO(r)}${soCanal}`).get().n;
        contagem.qualificados = doResultado('qualificado');
        contagem.desqualificados = doResultado('desqualificado');
      }
      // O número do botão de campanha, no modo escolhido.
      contagem.respondeuCampanha = daCampanha
        ? db.prepare(`SELECT COUNT(*) n FROM conv_conversas
            WHERE substr(telefone, -8) IN (${daCampanha.sql})${soCanal}`).get(...daCampanha.args).n
        : 0;
      // Os números da empresa, para o filtro. Com um só, a tela esconde o filtro.
      const numeros = require('./whatsapp-canais').listarCanais(db).map(w => ({ id: w.id, nome: w.nome, padrao: w.padrao }));
      // O aviso de mensagem nova da tela: a última recebida (1:1) e quantas
      // chegaram depois da que a tela já tinha visto (`desde`).
      let recebidas = null;
      if (temMensagens) {
        const RECEBIDA = "from_me = 0 AND remote_jid LIKE '%@s.whatsapp.net'";
        const ultimoId = db.prepare(`SELECT MAX(id) m FROM whatsapp_messages WHERE ${RECEBIDA}`).get().m || 0;
        const desde = Number(req.query.desde);
        const novas = Number.isFinite(desde) && desde > 0
          ? db.prepare(`SELECT COUNT(*) n FROM whatsapp_messages WHERE id > ? AND ${RECEBIDA}`).get(desde).n : 0;
        recebidas = { ultimoId, novas };
      }
      res.json({ success: true, conversas: linhas.map(c => ({ ...c, etiquetas: jsonOu(c.etiquetas, []) })), contagem,
        canais: numeros, recebidas, nichos: nichosComCampanha(db) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ATENÇÃO à ordem: estas rotas têm caminho literal e precisam ser
  // registradas ANTES de /api/conversas/:id — senão o Express casa
  // 'campanhas' com :id e responde 'Conversa não encontrada'.
  /**
   * Campanhas das DUAS fontes numa lista só.
   *
   * O módulo foi construído duas vezes — comm_campanhas (com lista, template e
   * opt-out modelados, nunca usado) e wa_campanhas (usado de fato). Enquanto a
   * decisão de qual aposentar não vem, a tela mostra as duas com a origem à
   * vista, em vez de fingir que só existe uma.
   */
  app.get('/api/conversas/campanhas', (req, res) => {
    try {
      const linhas = [];
      try {
        // A lista e o modelo vêm junto: sem eles, a tela mostra a campanha sem
        // dizer para quem ela vai nem o que ela manda, e quem abre adivinha.
        for (const c of db.prepare(`SELECT c.*, l.nome AS listaNome, t.nome AS templateNome
              FROM comm_campanhas c
              LEFT JOIN comm_listas l ON l.id = c.listaId
              LEFT JOIN comm_templates t ON t.id = c.templateId
              ORDER BY c.id DESC LIMIT 100`).all()) {
          linhas.push({ origem: 'comm', id: c.id, nome: c.nome, status: c.status,
                        canal: c.canal || null, criadoEm: c.dataCriacao || null, destinatarios: null,
                        totalDestinatarios: c.totalDestinatarios, tipo: c.tipo || null,
                        rodada: c.rodada || 1,
                        agendadaPara: c.agendadaPara || null,
                        listaId: c.listaId || null, listaNome: c.listaNome || null,
                        templateId: c.templateId || null, templateNome: c.templateNome || null });
        }
      } catch { /* tenant sem o módulo antigo */ }
      try {
        for (const c of db.prepare('SELECT * FROM wa_campanhas ORDER BY id DESC LIMIT 100').all()) {
          const cfg = jsonOu(c.config, {});
          const dest = db.prepare(`SELECT status, COUNT(*) n FROM wa_campanha_dest
            WHERE campanha_id = ? GROUP BY status`).all(c.id);
          // A campanha legado manda o modelo escolhido nela (desde 28/09). A
          // linha diz qual, como a das campanhas novas já dizia.
          let templateNome = null;
          if (cfg.templateId) {
            try { templateNome = db.prepare('SELECT nome FROM comm_templates WHERE id = ?').get(cfg.templateId)?.nome || null; }
            catch { /* tenant sem a tabela dos modelos */ }
          }
          linhas.push({ origem: 'wa', id: c.id, nome: c.nome || cfg.nome, status: c.status,
                        canal: 'whatsapp', criadoEm: c.criado_em || null,
                        descricao: cfg.descricao || null, agendadaPara: cfg.agendadaPara || null,
                        templateId: cfg.templateId || null, templateNome,
                        destinatarios: dest.reduce((o, d) => (o[d.status] = d.n, o), {}) });
        }
      } catch { }
      res.json({ success: true, campanhas: linhas });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  /**
   * Público possível para uma campanha de WhatsApp: quem tem telefone no
   * cadastro, já marcando quem aceitou marketing e quem pediu para sair.
   *
   * Mostrar o opt-out aqui, e não só na hora do envio, é o que evita montar
   * lista com gente que já pediu para não receber.
   */
  // LOWER do SQLite só conhece ASCII: "JOSÉ" viraria "josÉ" e não casaria com
  // "josé". Esta é a do JavaScript, a mesma que o filtro usava antes de ir ao SQL.
  // Registrada na conexão REAL do tenant, na primeira chamada: no boot o `db`
  // é o proxy multi-tenant, e registrar ali não chegaria a banco nenhum.
  const comMinusculo = new WeakSet();
  const garantirMinusculo = () => {
    const real = db.__real || db;
    if (comMinusculo.has(real)) return;
    real.function('minusculo', { deterministic: true }, (v) => (v == null ? null : String(v).toLowerCase()));
    comMinusculo.add(real);
  };
  app.get('/api/conversas/publico', (req, res) => {
    try {
      garantirMinusculo();
      const q = String(req.query.q || '').trim().toLowerCase();
      const f = {
        uf: String(req.query.uf || '').trim().toUpperCase(),
        cidade: String(req.query.cidade || '').trim().toLowerCase(),
        marketing: String(req.query.marketing || ''),      // '1' aceita | '0' não aceita
        compraram: String(req.query.compraram || ''),      // '1' com pedido | '0' sem pedido
        tag: String(req.query.tag || '').trim().toLowerCase(),
        segmento: Number(req.query.segmento) || 0,
        nicho: Number(req.query.nicho) || 0,
      };
      // Os filtros vão no SQL, ANTES do limite. Filtrados depois dele, como
      // eram até 28/09, eles só enxergavam os 2.000 primeiros em ordem
      // alfabética: com os leads das listas no cadastro (27 mil no 1bit), quem
      // buscasse um nome depois da letra C não o achava.
      const onde = ["ativo = 1", "TRIM(COALESCE(telefone,'')) <> ''"];
      const args = {};
      if (q) {
        onde.push(`(minusculo(COALESCE(razaoSocial,'')) LIKE @q OR minusculo(COALESCE(nomeFantasia,'')) LIKE @q
          OR COALESCE(telefone,'') LIKE @q OR minusculo(COALESCE(cidade,'')) LIKE @q)`);
        args.q = `%${q}%`;
      }
      if (f.uf) { onde.push('UPPER(COALESCE(uf,\'\')) = @uf'); args.uf = f.uf; }
      if (f.cidade) { onde.push("minusculo(COALESCE(cidade,'')) LIKE @cidade"); args.cidade = `%${f.cidade}%`; }
      if (f.marketing === '1') onde.push('COALESCE(aceitaWhatsappMarketing, 0) = 1');
      if (f.marketing === '0') onde.push('COALESCE(aceitaWhatsappMarketing, 0) = 0');
      const comPedido = 'EXISTS (SELECT 1 FROM pedidos ped WHERE ped.clienteId = pessoas.id)';
      if (f.compraram === '1') onde.push(comPedido);
      if (f.compraram === '0') onde.push(`NOT ${comPedido}`);
      if (f.tag) {
        onde.push("minusculo(COALESCE(categorias,'') || ' ' || COALESCE(tags,'')) LIKE @tag");
        args.tag = `%${f.tag}%`;
      }
      if (f.segmento) { onde.push('segmentoId = @segmento'); args.segmento = f.segmento; }
      // Nicho do funil (nicho-funil.js): o outro recorte do mesmo cadastro, e
      // o que a tela de Listas manda quando a escolha é do grupo dos funis.
      if (f.nicho) { onde.push('nichoFunilId = @nicho'); args.nicho = f.nicho; }
      const where = onde.join(' AND ');
      const total = db.prepare(`SELECT COUNT(*) n FROM pessoas WHERE ${where}`).get(args).n;
      const linhas = db.prepare(`SELECT id, razaoSocial, nomeFantasia, telefone, cidade, uf, segmentoId, nichoFunilId,
             COALESCE(categorias,'') AS categorias, COALESCE(tags,'') AS tags,
             COALESCE(aceitaWhatsappMarketing, 0) AS aceitaMarketing,
             (SELECT COUNT(*) FROM pedidos ped WHERE ped.clienteId = pessoas.id) AS pedidos
        FROM pessoas
        WHERE ${where}
        ORDER BY razaoSocial LIMIT 2000`).all(args);

      // Opt-out casa por destino normalizado — mesmo critério do envio.
      let fora = new Set();
      try {
        fora = new Set(db.prepare("SELECT destino FROM comm_optout WHERE canal = 'whatsapp'")
          .all().map(r => soDigitos(r.destino).slice(-8)));
      } catch { }
      // Opções para os selects saem do que existe de fato no cadastro.
      const todas = db.prepare(`SELECT DISTINCT uf FROM pessoas
        WHERE ativo = 1 AND TRIM(COALESCE(uf,'')) <> '' ORDER BY uf`).all().map(r => r.uf);
      res.json({ success: true, ufs: todas, total, pessoas: linhas.map(p => ({
        ...p, aceitaMarketing: !!p.aceitaMarketing,
        optOut: fora.has(soDigitos(p.telefone).slice(-8)),
      })) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  /** Uma campanha legado com o config aberto, para a tela poder editá-la. */
  app.get('/api/conversas/campanhas/wa/:id', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM wa_campanhas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
      const dest = db.prepare(`SELECT status, COUNT(*) n FROM wa_campanha_dest
        WHERE campanha_id = ? GROUP BY status`).all(c.id)
        .reduce((o, d) => (o[d.status] = d.n, o), {});
      // `mensagemPorModelo` diz à tela que este servidor já envia pelo modelo.
      // A tela entra no ar ao salvar e o servidor só no restart; sem o sinal,
      // ela ofereceria escolher um modelo que o motor antigo ignoraria,
      // mandando o texto da IA no lugar dele.
      res.json({ success: true, campanha: { ...c, config: jsonOu(c.config, {}) }, destinatarios: dest,
                 mensagemPorModelo: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  /**
   * Edita a campanha legado. O config dela é um objeto grande (briefing,
   * persona, regras, ritmo, horário) que o gerador de mensagem consome — por
   * isso o corpo aceita um merge parcial: a tela manda só o que mexeu, e o
   * resto do config fica como está.
   */
  app.put('/api/conversas/campanhas/wa/:id', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM wa_campanhas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
      if (String(c.status) === 'enviando') {
        return res.status(400).json({ success: false, error: 'Campanha em envio — pause antes de editar' });
      }
      const atual = jsonOu(c.config, {});
      let mudancas = req.body?.config;
      if (typeof mudancas === 'string') {
        try { mudancas = JSON.parse(mudancas); }
        catch { return res.status(400).json({ success: false, error: 'Configuração avançada não é um JSON válido' }); }
      }
      if (mudancas && typeof mudancas !== 'object') {
        return res.status(400).json({ success: false, error: 'Configuração inválida' });
      }
      const novo = { ...atual, ...(mudancas || {}) };
      // O modelo é o texto que vai para cada contato: gravar um que não existe,
      // ou um de e-mail, só apareceria como recusa na hora do envio.
      if (mudancas && 'templateId' in mudancas && novo.templateId != null && novo.templateId !== '') {
        const t = db.prepare('SELECT canal FROM comm_templates WHERE id = ?').get(Number(novo.templateId));
        if (!t) return res.status(400).json({ success: false, error: 'Modelo de mensagem não encontrado' });
        if (t.canal !== 'whatsapp') return res.status(400).json({ success: false, error: 'O modelo precisa ser de WhatsApp' });
        novo.templateId = Number(novo.templateId);
      } else if (mudancas && 'templateId' in mudancas) {
        delete novo.templateId;
      }
      // O horário de envio vale de verdade desde 28/09: gravar um que o motor
      // não entende pausaria a campanha na hora do envio. `null` tira o horário.
      // O roteiro de qualificação da campanha (roteiro-conversa.js). Vazio = nenhum.
      if (mudancas && 'roteiro_id' in mudancas) {
        try { novo.roteiro_id = require('./roteiro-conversa').roteiroEscolhido(db, novo.roteiro_id); }
        catch (e) { return res.status(400).json({ success: false, error: e.message }); }
        if (novo.roteiro_id == null) delete novo.roteiro_id;
      }
      // Por quais números a campanha sai. Vazio = o padrão; número que não é
      // da empresa é recusado, e não gravado para falhar na hora do envio.
      if (mudancas && 'canais' in mudancas) {
        try { novo.canais = require('./whatsapp-canais').validarNumeros(db, novo.canais); }
        catch (e) { return res.status(400).json({ success: false, error: e.message }); }
        if (!novo.canais.length) delete novo.canais;
      }
      if (mudancas && 'horario_permitido' in mudancas) {
        if (novo.horario_permitido == null) delete novo.horario_permitido;
        else {
          const h = require('./wa-campaigns-routes').horarioDaCampanha(novo.horario_permitido);
          if (h.erro) return res.status(400).json({ success: false, error: h.erro });
          novo.horario_permitido = { inicio: h.inicio, fim: h.fim, dias: h.dias };
        }
      }
      const nome = String(req.body?.nome ?? c.nome ?? novo.nome ?? '').trim();
      if (!nome) return res.status(400).json({ success: false, error: 'Informe o nome da campanha' });
      novo.nome = nome;

      db.prepare('UPDATE wa_campanhas SET nome = ?, config = ? WHERE id = ?')
        .run(nome, JSON.stringify(novo), c.id);
      res.json({ success: true, campanha: { ...c, nome, config: novo } });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * Cancelar campanha: marca os destinatários pendentes como cancelados.
   * É a ação da "fase 0" — parar disparo frio que ficou parado no meio.
   */
  app.post('/api/conversas/campanhas/wa/:id/cancelar', (req, res) => {
    try {
      const r = db.prepare(`UPDATE wa_campanha_dest SET status = 'cancelado'
        WHERE campanha_id = ? AND status = 'pendente'`).run(req.params.id);
      db.prepare("UPDATE wa_campanhas SET status = 'cancelada' WHERE id = ?").run(req.params.id);
      res.json({ success: true, cancelados: r.changes });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * Quem pode assumir uma conversa.
   *
   * Rota própria, e não `/api/usuarios`, por dois motivos. Aquela exige role
   * admin para listar geral, e só abre para os demais com `?vendedor=1` — mas
   * atendente de WhatsApp não é necessariamente vendedor, então a lista sairia
   * incompleta justamente para quem atende. E ela devolve o cadastro inteiro,
   * que esta tela não tem por que ver.
   *
   * Aqui saem só id e nome de quem está ativo. Nada de e-mail, hash, papel ou
   * comissão.
   */
  app.get('/api/conversas/atendentes', (req, res) => {
    try {
      const linhas = db.prepare(`SELECT id, COALESCE(NULLIF(nome, ''), username) AS nome
        FROM users WHERE ativo = 1 ORDER BY nome COLLATE NOCASE`).all();
      res.json({ success: true, atendentes: linhas, eu: Number(req.user?.id) || null });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  /** Oportunidades sem conversa ligada, para o vendedor escolher qual vincular. */
  app.get('/api/conversas/oportunidades/livres', (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      let linhas = db.prepare(`SELECT o.id, o.titulo, o.valor, e.nome AS etapaNome, ${require('./lead-ficha').nomeExibido('p')} AS clienteNome
        FROM crm_oportunidades o
        LEFT JOIN crm_etapas e ON e.id = o.etapaId
        LEFT JOIN pessoas p ON p.id = o.clienteId
        WHERE o.ativo = 1 AND o.id NOT IN (SELECT COALESCE(oportunidadeId,0) FROM conv_conversas)
        ORDER BY o.id DESC LIMIT 100`).all();
      if (q) linhas = linhas.filter(o => [o.titulo, o.clienteNome].some(v => String(v||'').toLowerCase().includes(q)));
      res.json({ success: true, oportunidades: linhas });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ---------- a mídia de uma mensagem (wa-midia.js) ----------
  // Buscada na Evolution quando a conversa abre, e guardada no disco do tenant.
  app.get('/api/conversas/midia/:id', async (req, res) => {
    try {
      const slug = req.tenantCtx && req.tenantCtx.slug;
      const m = await require('./wa-midia').obter(req.tenantDb || db, slug, req.params.id);
      res.type(m.mimetype);
      if (m.fileName) res.set('Content-Disposition', `inline; filename="${String(m.fileName).replace(/["\r\n]/g, '')}"`);
      res.set('Cache-Control', 'private, max-age=86400');
      res.sendFile(m.arquivo);
    } catch (e) { res.status(e.status || 500).json({ success: false, error: e.message }); }
  });

  /**
   * Abre o contato que só RECEBEU campanha e nunca escreveu.
   *
   * Ele aparece na caixa dentro de um nicho (destinosSemConversa) e não tem
   * conversa: ela nasce aqui, no clique, com as mensagens que já estão gravadas
   * em `whatsapp_messages` — a campanha grava o que sai, mas de propósito não
   * cria conversa (seriam 27 mil no 1bit). Idempotente: abrir duas vezes
   * devolve a mesma.
   */
  app.post('/api/conversas/abrir-destino', (req, res) => {
    try {
      const tel = soDigitos(req.body?.telefone);
      if (tel.length < 8) return res.status(400).json({ success: false, error: 'Telefone inválido' });
      const canalId = Number(req.body?.canalId) || 0;
      const id = garantirConversa(db, { jid: tel + '@s.whatsapp.net', canalId });
      // O resumo da lista vem da última mensagem gravada daquele número, para a
      // conversa não nascer em branco na caixa.
      try {
        const m = db.prepare(`SELECT texto, timestamp FROM whatsapp_messages
          WHERE remote_jid = ? ORDER BY id DESC LIMIT 1`).get(tel + '@s.whatsapp.net');
        if (m) {
          db.prepare(`UPDATE conv_conversas SET ultimaMensagem = COALESCE(ultimaMensagem, ?),
            ultimaEm = COALESCE(ultimaEm, datetime(?, 'unixepoch')) WHERE id = ?`)
            .run(String(m.texto || '').slice(0, 300), m.timestamp || null, id);
        }
      } catch { /* sem a tabela de mensagens */ }
      res.json({ success: true, id });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // ---------- uma conversa, com o que o ERP sabe do contato ----------
  app.get('/api/conversas/:id', (req, res) => {
    try {
      const c = db.prepare(`SELECT c.*, ${require('./lead-ficha').nomeExibido('p')} AS pessoaNome, p.cpfCnpj, p.email, p.cidade, p.uf,
          COALESCE(NULLIF(u.nome, ''), u.username) AS donoNome, w.nome AS canalNome
        FROM conv_conversas c
        LEFT JOIN pessoas p ON p.id = c.pessoaId
        LEFT JOIN users u ON u.id = c.donoId
        LEFT JOIN whatsapp_canais w ON w.id = c.canalId
        WHERE c.id = ?`).get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });

      let mensagens = [];
      try {
        // As 400 ÚLTIMAS, não as 400 primeiras: o corte era por id ASC, então
        // conversa longa abria no começo do histórico e o atendente nunca via
        // o que acabou de chegar. A ordem final volta a ser cronológica.
        //
        // O veredito vem junto para a tela mostrar o que já foi avaliado: sem
        // isso, reabrir a conversa apaga o rastro do que o atendente revisou.
        mensagens = mensagensDaConversa(db, c);
      } catch { /* sem tabela de mensagens ainda */ }
      // Há mais antigas do que as que couberam? Sem isto a tela cortava em 400
      // sem dizer nada: no 1bit são 15 conversas em que o histórico simplesmente
      // não aparecia, e quem procurava uma mensagem antiga não a achava.
      let temMais = false;
      try {
        if (mensagens.length) {
          temMais = !!db.prepare(`SELECT 1 FROM whatsapp_messages m, (SELECT ? AS jid, ? AS canalId) c
            WHERE ${MSG_DA_CONVERSA} AND m.id < ? LIMIT 1`).get(c.jid, c.canalId || 0, mensagens[0].id);
        }
      } catch { /* sem tabela */ }

      // Ficha: o que faz o atendente responder sem trocar de tela.
      const ficha = { pedidos: [], titulos: [] };
      if (c.pessoaId) {
        try {
          ficha.pedidos = db.prepare(`SELECT id, numero, status, dataPedido, valorTotal FROM pedidos
            WHERE clienteId = ? ORDER BY id DESC LIMIT 5`).all(c.pessoaId);
        } catch { }
        try {
          ficha.titulos = db.prepare(`SELECT id, descricao, valor, dataVencimento, status FROM contas_a_receber
            WHERE pessoaId = ? AND status <> 'paga' ORDER BY dataVencimento LIMIT 5`).all(c.pessoaId);
        } catch { }
      }
      db.prepare('UPDATE conv_conversas SET naoLidas = 0 WHERE id = ?').run(c.id);
      // A pausa da IA vai junto: é o que a tela precisa para dizer que a IA está
      // calada e até quando, em vez de deixar quem testa achando que quebrou.
      const pausa = pausaDaIA(db, { jid: c.jid, instance: null, canalId: c.canalId, conversaId: c.id });
      res.json({ success: true, conversa: { ...c, etiquetas: jsonOu(c.etiquetas, []) }, mensagens, ficha, pausaIA: pausa, temMais });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ---------- responder ----------
  app.post('/api/conversas/:id/responder', async (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
      const texto = String(req.body?.texto || '').trim();
      if (!texto) return res.status(400).json({ success: false, error: 'Escreva a mensagem' });
      // Responder CITANDO (01/10/2026): `citarId` é o id local da mensagem que a
      // resposta cita. A chave que o WhatsApp precisa é o `wa_message_id` dela,
      // e mensagem sem esse id (histórico importado, envio que a Evolution não
      // confirmou) não pode ser citada — aí a resposta sai sem citação, em vez
      // de não sair.
      const citar = citarDaMensagem(db, c, req.body?.citarId);

      const { enviarWhatsApp } = require('./whatsapp-adapter');
      // ignorarRitmo: é resposta a quem escreveu, não disparo.
      // Sai pelo número da conversa: quem escreveu para o suporte ouve o suporte.
      // `deBot: false`: quem responde aqui é o atendente, e é essa marca que
      // arma a pausa de 4 horas da IA (pausaDaIA). Marcada como do sistema, a
      // resposta humana não pausaria nada.
      const r = await enviarWhatsApp(db, { telefone: c.telefone, texto, ignorarRitmo: true,
        canalId: c.canalId || null, deBot: false, citar });
      if (r.error) return res.status(400).json({ success: false, error: r.error });

      try {
        db.prepare(`INSERT OR IGNORE INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, texto, timestamp, citaWaId)
          VALUES (?,?,?,1,?,?,?)`).run(r.providerMessageId || null, r.instance || null, c.jid, texto,
            Math.floor(Date.now() / 1000), (citar && citar.waId) || null);
      } catch { }
      registrarMensagem(db, { jid: c.jid, texto, deMim: true, canalId: c.canalId || 0 });
      // Humano respondeu: a IA sai de cena nesta conversa até alguém religar.
      db.prepare('UPDATE conv_conversas SET iaAtiva = 0 WHERE id = ?').run(c.id);
      evento(c.id, 'resposta', null, req);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // ---------- estado, dono, etiquetas, IA ----------
  app.put('/api/conversas/:id', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
      const b = req.body || {};

      if (b.estado != null) {
        if (!ESTADOS.includes(b.estado)) return res.status(400).json({ success: false, error: 'Estado inválido' });
        db.prepare(`UPDATE conv_conversas SET estado = ?,
            resolvidaEm = CASE WHEN ? = 'resolvida' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id = ?`)
          .run(b.estado, b.estado, c.id);
        evento(c.id, 'estado', b.estado, req);
      }
      if (b.donoId !== undefined) {
        // Atribuir a quem não existe, ou a quem foi desativado, produz uma fila
        // que ninguém vê: a conversa sai de "sem dono" e não entra no "minhas"
        // de pessoa alguma. Some calada, que é o pior jeito de sumir.
        let dono = null;
        if (b.donoId) {
          const u = db.prepare('SELECT id FROM users WHERE id = ? AND ativo = 1').get(Number(b.donoId));
          if (!u) return res.status(400).json({ success: false, error: 'Atendente inexistente ou inativo' });
          dono = u.id;
        }
        db.prepare('UPDATE conv_conversas SET donoId = ? WHERE id = ?').run(dono, c.id);
        evento(c.id, 'dono', String(dono || 'ninguém'), req);
      }
      if (Array.isArray(b.etiquetas)) {
        const limpas = [...new Set(b.etiquetas.map(x => String(x).trim()).filter(Boolean))].slice(0, 10);
        db.prepare('UPDATE conv_conversas SET etiquetas = ? WHERE id = ?').run(JSON.stringify(limpas), c.id);
      }
      if (b.iaAtiva !== undefined) {
        db.prepare('UPDATE conv_conversas SET iaAtiva = ? WHERE id = ?').run(b.iaAtiva ? 1 : 0, c.id);
        evento(c.id, 'ia', b.iaAtiva ? 'ligada' : 'desligada', req);
      }
      if (b.pessoaId !== undefined) {
        db.prepare('UPDATE conv_conversas SET pessoaId = ? WHERE id = ?').run(b.pessoaId || null, c.id);
        evento(c.id, 'vinculo', String(b.pessoaId || 'removido'), req);
      }
      const atual = db.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(c.id);
      res.json({ success: true, conversa: { ...atual, etiquetas: jsonOu(atual.etiquetas, []) } });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // ---------- oportunidade no CRM ----------
  //
  // A conversa não tem funil próprio: ela aponta para uma oportunidade do CRM,
  // que já existe e é onde a equipe acompanha venda. O quadro continua sendo o
  // de Comercial → CRM · Funil.

  app.get('/api/conversas/:id/oportunidade', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
      if (!c.oportunidadeId) return res.json({ success: true, oportunidade: null });
      const o = db.prepare(`SELECT o.*, e.nome AS etapaNome, e.cor AS etapaCor, f.nome AS funilNome
        FROM crm_oportunidades o
        LEFT JOIN crm_etapas e ON e.id = o.etapaId
        LEFT JOIN crm_funis f ON f.id = o.funilId
        WHERE o.id = ?`).get(c.oportunidadeId);
      res.json({ success: true, oportunidade: o || null });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  /** Cria a oportunidade no CRM a partir da conversa e amarra as duas. */
  /**
   * Retoma a IA numa conversa em que alguém respondeu à mão. Sem isto, a única
   * saída era esperar as 4 horas da pausa (ver `pausaDaIA`), e nada na tela
   * dizia que a espera existia.
   */
  /** O pedaço anterior do histórico: o "carregar mensagens anteriores" da tela. */
  app.get('/api/conversas/:id/mensagens', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
      const antesDe = Number(req.query.antesDe) || null;
      const mensagens = mensagensDaConversa(db, c, { antesDe });
      const temMais = mensagens.length
        ? !!db.prepare(`SELECT 1 FROM whatsapp_messages m, (SELECT ? AS jid, ? AS canalId) c
            WHERE ${MSG_DA_CONVERSA} AND m.id < ? LIMIT 1`).get(c.jid, c.canalId || 0, mensagens[0].id)
        : false;
      res.json({ success: true, mensagens, temMais });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  /**
   * Apagar para todos — a mesma ação do WhatsApp, e com os mesmos limites dele:
   * só mensagem NOSSA, e só a que tem registro no WhatsApp.
   *
   * A mensagem não sai da tabela. Ela ganha `apagadaEm`, igual ao que o webhook
   * faz quando é o contato que apaga: o histórico de atendimento é registro, e
   * apagar no aparelho do outro não é apagar o que aconteceu. A tela mostra o
   * conteúdo com a marca "Você apagou".
   */
  // Sessenta horas (dois dias e meio) é o limite do WhatsApp para apagar para
  // todos. Conferir aqui faz a recusa chegar dita, em vez de voltar como erro
  // cru da Evolution — e sem gastar a chamada, como na edição.
  const APAGAR_ATE_MS = 60 * 60 * 60 * 1000;
  app.delete('/api/conversas/:id/mensagens/:msgId', async (req, res) => {
    try {
      const { c, m, erro } = minhaMensagem(db, req.params.id, req.params.msgId);
      if (erro) return res.status(erro.status).json({ success: false, error: erro.error });
      if (m.apagadaEm) return res.json({ success: true, jaEstava: true });
      const idade = Date.now() - (Number(m.timestamp) || 0) * 1000;
      if (idade > APAGAR_ATE_MS) {
        return res.status(400).json({ success: false, error: 'O WhatsApp só deixa apagar para todos nas primeiras 60 horas' });
      }

      const r = await require('./whatsapp-adapter').apagarParaTodos(db,
        { canalId: c.canalId || null, jid: c.jid, waId: m.wa_message_id });
      if (!r.success) return res.status(400).json({ success: false, error: r.error });

      const agora = new Date().toISOString();
      db.prepare('UPDATE whatsapp_messages SET apagadaEm = ? WHERE id = ? AND apagadaEm IS NULL').run(agora, m.id);
      evento(c.id, 'mensagem', 'apagada', req);
      res.json({ success: true, apagadaEm: agora });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * Editar a mensagem enviada, dentro da janela do WhatsApp.
   *
   * Os 15 minutos são regra DELE, e são conferidos aqui para a recusa chegar
   * dita, em vez de voltar como erro cru da Evolution. O texto só é regravado
   * depois de o WhatsApp aceitar a troca: regravar antes deixaria a nossa tela
   * mostrando uma coisa e o aparelho do contato outra.
   */
  const EDITAR_ATE_MS = 15 * 60 * 1000;
  app.put('/api/conversas/:id/mensagens/:msgId', async (req, res) => {
    try {
      const { c, m, erro } = minhaMensagem(db, req.params.id, req.params.msgId);
      if (erro) return res.status(erro.status).json({ success: false, error: erro.error });
      const texto = String(req.body?.texto || '').trim();
      if (!texto) return res.status(400).json({ success: false, error: 'Escreva o texto novo' });
      if (m.apagadaEm) return res.status(400).json({ success: false, error: 'Mensagem apagada não se edita' });
      const idade = Date.now() - (Number(m.timestamp) || 0) * 1000;
      if (idade > EDITAR_ATE_MS) {
        return res.status(400).json({ success: false, error: 'O WhatsApp só deixa editar nos primeiros 15 minutos' });
      }

      const r = await require('./whatsapp-adapter').editarMensagem(db,
        { canalId: c.canalId || null, jid: c.jid, waId: m.wa_message_id, telefone: c.telefone, texto });
      if (!r.success) return res.status(400).json({ success: false, error: r.error });

      const agora = new Date().toISOString();
      db.prepare('UPDATE whatsapp_messages SET texto = ?, editadaEm = ? WHERE id = ?').run(texto, agora, m.id);
      // A prévia da lista é a última mensagem: editada a última, a lista tem de
      // acompanhar, senão a conversa fica mostrando um texto que já não existe.
      try {
        const ultima = db.prepare(`SELECT m.id FROM whatsapp_messages m, (SELECT ? AS jid, ? AS canalId) c
          WHERE ${MSG_DA_CONVERSA} ORDER BY m.id DESC LIMIT 1`).get(c.jid, c.canalId || 0);
        if (ultima && ultima.id === m.id) {
          db.prepare('UPDATE conv_conversas SET ultimaMensagem = ? WHERE id = ?').run(texto.slice(0, 200), c.id);
        }
      } catch { /* sem a tabela de mensagens */ }
      evento(c.id, 'mensagem', 'editada', req);
      res.json({ success: true, texto, editadaEm: agora });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * O anexo da barra de escrever: imagem, vídeo ou documento pela conversa.
   *
   * `reentrarContextoTenant` logo depois do multer, pela mesma razão do PDF da
   * base da IA: o busboy lê o corpo em streaming e o contexto do tenant se perde
   * no meio, e sem isso o upload volta 400 dizendo "currentDb() fora de contexto".
   *
   * O arquivo é guardado no disco do tenant com o id da mensagem gravada, para o
   * balão mostrar o que saiu sem pedir de volta à Evolution o arquivo que acabou
   * de sair daqui (wa-midia.guardarEnviada).
   */
  const multerAnexo = require('multer');
  const uploadAnexo = multerAnexo({ storage: multerAnexo.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
  const TIPO_DA_MIDIA = { image: 'imageMessage', video: 'videoMessage', document: 'documentMessage' };
  app.post('/api/conversas/:id/anexo', uploadAnexo.single('arquivo'), reentrarContextoTenant, async (req, res) => {
    const fs = require('fs'), path = require('path'), os = require('os');
    let temporario = null;
    try {
      const tdb = req.tenantDb || db;
      const c = tdb.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
      if (!req.file) return res.status(400).json({ success: false, error: 'Escolha o arquivo' });

      const { enviarWhatsAppMidia, midiaDoCaminho } = require('./whatsapp-adapter');
      const nome = String(req.file.originalname || 'arquivo').replace(/[/\\\r\n"]/g, '_');
      const ext = path.extname(nome).toLowerCase();
      const { mediatype, mimetype } = midiaDoCaminho(nome);
      // Extensão que não é imagem conhecida nem documento da lista cairia como
      // imagem, e chegaria quebrada ao contato. Melhor recusar dizendo qual é.
      if (mediatype === 'image' && !['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
        return res.status(400).json({ success: false, error: `Não sei mandar arquivo ${ext || 'sem extensão'} pelo WhatsApp` });
      }
      // A Evolution lê o arquivo do disco (enviarWhatsAppMidia), então o que vem
      // em memória passa por um temporário, apagado no fim de qualquer caminho.
      temporario = path.join(os.tmpdir(), `wa-anexo-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
      fs.writeFileSync(temporario, req.file.buffer);

      const legenda = String(req.body?.texto || '').trim();
      const r = await enviarWhatsAppMidia(tdb, { telefone: c.telefone, texto: legenda,
        imagePath: temporario, canalId: c.canalId || null, ignorarRitmo: true });
      if (!r.success) return res.status(400).json({ success: false, error: r.error || 'O arquivo não saiu' });

      // O tipo e o arquivo na mensagem que o registro do envio acabou de gravar:
      // é o que faz o balão mostrar a mídia em vez de "(sem texto)".
      try {
        const m = tdb.prepare(`SELECT id FROM whatsapp_messages
          WHERE wa_message_id = ? AND instance = ? ORDER BY id DESC LIMIT 1`).get(r.providerMessageId, r.instance);
        if (m) {
          tdb.prepare('UPDATE whatsapp_messages SET message_type = ? WHERE id = ?').run(TIPO_DA_MIDIA[mediatype], m.id);
          require('./wa-midia').guardarEnviada(req.tenantCtx && req.tenantCtx.slug, m.id, req.file.buffer, { mimetype, fileName: nome });
        }
      } catch (e) { console.error('[conversas] anexo guardar:', e.message); }
      registrarMensagem(tdb, { jid: c.jid, texto: legenda || nome, deMim: true, canalId: c.canalId || 0 });
      tdb.prepare('UPDATE conv_conversas SET iaAtiva = 0 WHERE id = ?').run(c.id);
      evento(c.id, 'anexo', mediatype, req);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    } finally {
      try { if (temporario) require('fs').unlinkSync(temporario); } catch { /* já apagado */ }
    }
  });

  app.post('/api/conversas/:id/retomar-ia', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
      // Liga a IA junto: quem clica em "Retomar" quer que ela responda, e o
      // desligamento manual é a outra metade do mesmo botão na tela.
      db.prepare('UPDATE conv_conversas SET iaAtiva = 1 WHERE id = ?').run(c.id);
      evento(c.id, 'ia', 'retomada', req);
      res.json({ success: true, pausa: pausaDaIA(db, { jid: c.jid, instance: null, canalId: c.canalId, conversaId: c.id }) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/conversas/:id/oportunidade', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
      if (c.oportunidadeId) return res.status(400).json({ success: false,
        error: 'Esta conversa já está ligada à oportunidade #' + c.oportunidadeId });

      // Vincular a uma existente é o caminho quando o vendedor já criou o card.
      const existente = Number(req.body?.oportunidadeId) || null;
      if (existente) {
        const o = db.prepare('SELECT id FROM crm_oportunidades WHERE id = ? AND ativo = 1').get(existente);
        if (!o) return res.status(404).json({ success: false, error: 'Oportunidade não encontrada' });
        db.prepare('UPDATE conv_conversas SET oportunidadeId = ? WHERE id = ?').run(existente, c.id);
        evento(c.id, 'oportunidade', 'vinculada #' + existente, req);
        return res.json({ success: true, oportunidadeId: existente, criada: false });
      }

      // Mesmas regras de default do CRM: primeiro funil ativo, primeira etapa
      // normal. Sem replicar tabela nem inventar etapa nova.
      const f = db.prepare('SELECT id FROM crm_funis WHERE ativo = 1 ORDER BY ordem LIMIT 1').get();
      if (!f) return res.status(400).json({ success: false, error: 'Nenhum funil cadastrado no CRM' });
      const e = db.prepare(`SELECT id FROM crm_etapas WHERE funilId = ? AND ativo = 1 AND tipo = 'normal'
        ORDER BY ordem LIMIT 1`).get(f.id);
      if (!e) return res.status(400).json({ success: false, error: 'Funil do CRM sem etapas' });

      const titulo = String(req.body?.titulo || '').trim()
        || `WhatsApp — ${c.nome || c.telefone}`;
      const topo = db.prepare('SELECT COALESCE(MIN(ordemManual), 0) - 1 AS o FROM crm_oportunidades WHERE etapaId = ? AND ativo = 1').get(e.id).o;
      const opId = db.prepare(`INSERT INTO crm_oportunidades
          (funilId, etapaId, clienteId, clienteNomeLivre, titulo, descricao, valor, fonte,
           dataAbertura, ativo, ordemManual)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'whatsapp', date('now','-3 hours'), 1, ?)`)
        .run(f.id, e.id, c.pessoaId || null, c.pessoaId ? null : (c.nome || c.telefone),
             titulo.slice(0, 160), c.ultimaMensagem || null,
             Number(req.body?.valor) || null, topo).lastInsertRowid;

      db.prepare('UPDATE conv_conversas SET oportunidadeId = ? WHERE id = ?').run(opId, c.id);
      evento(c.id, 'oportunidade', 'criada #' + opId, req);
      res.json({ success: true, oportunidadeId: opId, criada: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.delete('/api/conversas/:id/oportunidade', (req, res) => {
    try {
      db.prepare('UPDATE conv_conversas SET oportunidadeId = NULL WHERE id = ?').run(req.params.id);
      evento(Number(req.params.id), 'oportunidade', 'desvinculada', req);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // ---------- base de conhecimento da IA ----------
  app.get('/api/ia/base', (req, res) => {
    try {
      const itens = db.prepare('SELECT * FROM ia_base ORDER BY ativo DESC, titulo').all();
      const correcoes = db.prepare(`SELECT c.*, b.titulo AS baseTitulo FROM ia_correcoes c
        LEFT JOIN ia_base b ON b.id = c.baseId ORDER BY c.id DESC LIMIT 30`).all();
      res.json({ success: true, itens, correcoes });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/ia/base', (req, res) => {
    try {
      const t = String(req.body?.titulo || '').trim();
      const c = String(req.body?.conteudo || '').trim();
      if (!t || !c) return res.status(400).json({ success: false, error: 'Título e conteúdo são obrigatórios' });
      const id = db.prepare('INSERT INTO ia_base (titulo, conteudo, origem) VALUES (?,?,?)')
        .run(t.slice(0, 120), c.slice(0, 4000), String(req.body?.origem || '').slice(0, 120) || null).lastInsertRowid;
      res.json({ success: true, id });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * Base da IA a partir de um PDF.
   *
   * ── Por que fatia, em vez de gravar um item gigante ────────────────────────
   *
   * `ia_base.conteudo` guarda 4.000 caracteres, e um PDF de catálogo passa
   * disso na primeira página. Gravar truncado seria o pior resultado possível:
   * a IA responderia com meia informação e ninguém saberia que faltou metade.
   * Aqui o texto vira vários itens, cada um com a sua parte, e a contagem volta
   * para a tela.
   *
   * O corte procura uma quebra de parágrafo perto do limite: partir no meio de
   * uma frase produz item que não responde nada sozinho.
   *
   * ── O PDF digitalizado ─────────────────────────────────────────────────────
   *
   * `pdftotext` devolve vazio para PDF que é imagem de página. Isso é recusado
   * com o motivo dito, porque o erro silencioso aqui seria um item em branco na
   * base — e base em branco é IA que inventa.
   */
  const multer = require('multer');
  const uploadPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
  const PEDACO = 3500;
  const MAX_PEDACOS = 20;

  /** Quebra o texto em pedaços, preferindo cortar em parágrafo. */
  function fatiar(texto) {
    const limpo = texto.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
    const partes = [];
    let resto = limpo;
    while (resto.length > PEDACO) {
      const janela = resto.slice(0, PEDACO);
      let corte = janela.lastIndexOf('\n\n');
      if (corte < PEDACO * 0.5) corte = janela.lastIndexOf('. ');
      if (corte < PEDACO * 0.5) corte = PEDACO;
      partes.push(resto.slice(0, corte).trim());
      resto = resto.slice(corte).trim();
    }
    if (resto) partes.push(resto);
    return partes.filter(Boolean);
  }

  // reentrarContextoTenant logo depois do multer: o busboy lê o corpo em
  // callbacks que perdem o contexto do tenant, e o db respondia "currentDb()
  // chamado fora de contexto de tenant" (imagem do modelo do 1bit, 29/09).
  app.post('/api/ia/base/pdf', uploadPdf.single('arquivo'), reentrarContextoTenant, (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'Nenhum arquivo recebido' });
      const nome = String(req.file.originalname || 'documento.pdf').replace(/\.pdf$/i, '').slice(0, 90);
      if (!/^%PDF-/.test(req.file.buffer.slice(0, 5).toString('latin1'))) {
        return res.status(400).json({ success: false, error: 'O arquivo não é um PDF' });
      }

      const r = require('child_process').spawnSync('pdftotext',
        ['-enc', 'UTF-8', '-nopgbrk', '-', '-'], { input: req.file.buffer, maxBuffer: 64 * 1024 * 1024 });
      if (r.error || r.status !== 0) {
        return res.status(500).json({ success: false,
          error: 'Falha ao ler o PDF: ' + ((r.error && r.error.message) || String(r.stderr || '').trim() || 'pdftotext') });
      }

      const partes = fatiar(String(r.stdout || ''));
      if (!partes.length) {
        return res.status(400).json({ success: false,
          error: 'O PDF não tem texto — provavelmente é digitalizado (imagem). Envie o arquivo original ou digite o conteúdo.' });
      }

      const entram = partes.slice(0, MAX_PEDACOS);
      const ins = db.prepare('INSERT INTO ia_base (titulo, conteudo, origem) VALUES (?,?,?)');
      const gravar = db.transaction((lista) => {
        for (let i = 0; i < lista.length; i++) {
          const titulo = lista.length > 1 ? `${nome} (${i + 1}/${lista.length})` : nome;
          ins.run(titulo.slice(0, 120), lista[i].slice(0, 4000), ('PDF: ' + nome).slice(0, 120));
        }
      });
      gravar(entram);

      res.json({
        success: true, itens: entram.length,
        ignorados: partes.length - entram.length,
        // Dito, e não engolido: quem envia um manual de 200 páginas precisa
        // saber que só o começo entrou.
        aviso: partes.length > MAX_PEDACOS
          ? `O PDF rendeu ${partes.length} trechos e entraram os ${MAX_PEDACOS} primeiros. `
            + 'Envie o documento em partes, ou recorte o que a IA precisa saber.'
          : null,
      });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.put('/api/ia/base/:id', (req, res) => {
    try {
      const b = req.body || {};
      const atual = db.prepare('SELECT * FROM ia_base WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Item não encontrado' });
      db.prepare(`UPDATE ia_base SET titulo = ?, conteudo = ?, origem = ?, ativo = ?,
          dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(b.titulo != null ? String(b.titulo).slice(0, 120) : atual.titulo,
             b.conteudo != null ? String(b.conteudo).slice(0, 4000) : atual.conteudo,
             b.origem != null ? String(b.origem).slice(0, 120) : atual.origem,
             b.ativo === undefined ? atual.ativo : (b.ativo ? 1 : 0), atual.id);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.delete('/api/ia/base/:id', (req, res) => {
    try {
      db.prepare('DELETE FROM ia_base WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * Corrigir o robô: o atendente diz qual seria a resposta certa e aquilo
   * entra na base. É o "treino" que existe de fato num atendente de IA.
   */
  app.post('/api/ia/corrigir', (req, res) => {
    try {
      const b = req.body || {};
      const correta = String(b.correta || '').trim();
      if (!correta) return res.status(400).json({ success: false, error: 'Escreva a resposta correta' });
      let baseId = null;
      if (b.viraBase !== false) {
        const titulo = String(b.titulo || b.perguntou || 'Correção').trim().slice(0, 120);
        baseId = db.prepare('INSERT INTO ia_base (titulo, conteudo, origem) VALUES (?,?,?)')
          .run(titulo, correta.slice(0, 4000), 'correção de atendente').lastInsertRowid;
      }
      db.prepare(`INSERT INTO ia_correcoes (conversaId, mensagemId, perguntou, respondeu, correta, viraBase, baseId, usuario)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(b.conversaId || null, b.mensagemId || null, String(b.perguntou || '').slice(0, 1000),
             String(b.respondeu || '').slice(0, 2000), correta.slice(0, 4000),
             b.viraBase === false ? 0 : 1, baseId, usuario(req));
      res.json({ success: true, baseId });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * Aprovar a resposta: um clique, sem digitar nada. Só registra o voto — a
   * base não muda, porque não há o que ensinar quando a resposta saiu certa.
   * Serve para medir acerto e para o atendente marcar por onde já passou.
   */
  app.post('/api/ia/aprovar', (req, res) => {
    try {
      const b = req.body || {};
      const respondeu = String(b.respondeu || '').trim();
      if (!respondeu) return res.status(400).json({ success: false, error: 'Sem resposta para aprovar' });
      db.prepare(`INSERT INTO ia_correcoes (conversaId, mensagemId, perguntou, respondeu, correta, viraBase, veredito, usuario)
        VALUES (?,?,?,?,?,0,'certo',?)`)
        .run(b.conversaId || null, b.mensagemId || null, String(b.perguntou || '').slice(0, 1000),
             respondeu.slice(0, 2000), respondeu.slice(0, 4000), usuario(req));
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // ---------- painel ----------
  app.get('/api/conversas/painel/resumo', (req, res) => {
    try {
      sincronizar(db);
      const n = (sql, ...a) => { try { return db.prepare(sql).get(...a).n; } catch { return 0; } };
      res.json({ success: true, resumo: {
        abertas: n("SELECT COUNT(*) n FROM conv_conversas WHERE estado='aberta'"),
        pendentes: n("SELECT COUNT(*) n FROM conv_conversas WHERE estado='pendente'"),
        semResposta: n("SELECT COUNT(*) n FROM conv_conversas WHERE estado='aberta' AND primeiraRespostaEm IS NULL"),
        resolvidasHoje: n("SELECT COUNT(*) n FROM conv_conversas WHERE date(resolvidaEm,'-3 hours')=date('now','-3 hours')"),
        itensBase: n('SELECT COUNT(*) n FROM ia_base WHERE ativo=1'),
        correcoes: n('SELECT COUNT(*) n FROM ia_correcoes'),
      } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ---------- relatório ----------
  //
  // A pergunta que este endpoint existe para responder é "por que hoje não saiu
  // nada?". Volume sozinho não responde: silêncio da IA quase nunca é falha, é
  // uma das portas do autoResponder (whatsapp-webhook.js:72) fechando antes do
  // envio. Então além da série diária vai o FUNIL — quantos números escreveram e
  // quantos morreram em cada porta —, que é o que transforma "não enviou" em
  // "não enviou porque".
  // Sob /painel/ como o resumo acima, e não em /api/conversas/relatorio: o
  // /api/conversas/:id é registrado antes e captura qualquer segmento único.
  app.get('/api/conversas/painel/relatorio', (req, res) => {
    try {
      sincronizar(db);
      const dias = Math.max(1, Math.min(90, parseInt(req.query.dias, 10) || 14));
      const um = (sql, ...a) => { try { return db.prepare(sql).get(...a) || {}; } catch { return {}; } };
      const lista = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch { return []; } };
      const cfg = (k) => (um('SELECT valor FROM config WHERE chave = ?', k).valor || null);

      // Série diária. whatsapp_messages responde por tráfego real (o que o
      // cliente mandou e o que saiu daqui, humano ou IA); whatsapp_queue, por
      // envio do sistema — é lá que o erro do provedor aparece.
      const serie = lista(`
        WITH d(dia) AS (
          SELECT date('now','-3 hours', '-' || ? || ' days')
          UNION ALL SELECT date(dia,'+1 day') FROM d WHERE dia < date('now','-3 hours')
        )
        SELECT d.dia,
          (SELECT COUNT(*) FROM whatsapp_messages m
            WHERE substr(m.criado_em,1,10)=d.dia AND m.from_me=0) AS recebidas,
          (SELECT COUNT(*) FROM whatsapp_messages m
            WHERE substr(m.criado_em,1,10)=d.dia AND m.from_me=1 AND COALESCE(m.from_bot,0)=0) AS enviadasHumano,
          (SELECT COUNT(*) FROM whatsapp_messages m
            WHERE substr(m.criado_em,1,10)=d.dia AND COALESCE(m.from_bot,0)=1) AS enviadasIA,
          (SELECT COUNT(*) FROM whatsapp_queue q
            WHERE substr(q.dataCriacao,1,10)=d.dia AND q.status='erro') AS filaErro,
          (SELECT COUNT(*) FROM wa_campanha_dest x
            WHERE substr(x.enviado_em,1,10)=d.dia) AS disparosCampanha,
          (SELECT COUNT(*) FROM conv_conversas c
            WHERE substr(c.dataCriacao,1,10)=d.dia) AS conversasNovas
        FROM d ORDER BY d.dia
      `, dias - 1);

      // Funil: para cada número que escreveu HOJE, qual porta do autoResponder
      // o barraria. A ordem das cláusulas espelha a do código — quem morre na
      // primeira não chega na segunda, e contar de outro jeito daria totais
      // sobrepostos que não somam.
      //
      // Hoje, e não o período do gráfico, de propósito: "humano assumiu" é uma
      // janela de 4 horas contada a partir de agora. Aplicada sobre 14 dias ela
      // devolveria zero sempre e faria parecer que essa porta nunca fecha.
      const desde = `-${dias} days`;
      const funil = um(`
        WITH escreveram AS (
          SELECT DISTINCT remote_jid AS jid,
                 substr(remote_jid, 1, instr(remote_jid,'@')-1) AS num
          FROM whatsapp_messages
          WHERE from_me=0 AND date(criado_em) = date('now','-3 hours')
        ),
        marcado AS (
          SELECT e.jid,
            EXISTS (SELECT 1 FROM wa_campanha_dest d
                    WHERE (d.telefone = e.num OR d.jid = e.jid) AND d.enviado_em IS NOT NULL) AS deCampanha,
            EXISTS (SELECT 1 FROM whatsapp_messages m
                    WHERE m.remote_jid = e.jid AND m.from_me=1 AND COALESCE(m.from_bot,0)=0
                      AND m.timestamp >= strftime('%s','now') - 4*3600) AS humano4h,
            COALESCE((SELECT c.iaAtiva FROM conv_conversas c WHERE c.jid = e.jid), 1) AS iaAtiva,
            EXISTS (SELECT 1 FROM whatsapp_messages m
                    WHERE m.remote_jid = e.jid AND COALESCE(m.from_bot,0)=1
                      AND date(m.criado_em) = date('now','-3 hours')) AS respondida
          FROM escreveram e
        )
        SELECT COUNT(*) AS escreveram,
               SUM(CASE WHEN deCampanha=0 THEN 1 ELSE 0 END) AS foraDeCampanha,
               SUM(CASE WHEN deCampanha=1 AND humano4h=1 THEN 1 ELSE 0 END) AS humanoAssumiu,
               SUM(CASE WHEN deCampanha=1 AND humano4h=0 AND iaAtiva=0 THEN 1 ELSE 0 END) AS iaDesligada,
               SUM(CASE WHEN respondida=1 THEN 1 ELSE 0 END) AS respondidasPelaIA
        FROM marcado
      `);

      // Erros do provedor agrupados: 30 linhas do mesmo "número não existe" são
      // um problema, não trinta.
      const erros = lista(`
        SELECT COUNT(*) AS n, MAX(dataCriacao) AS ultimoEm,
          CASE
            WHEN erro LIKE '%"exists":false%' THEN 'Número não existe no WhatsApp'
            WHEN erro LIKE '%http 401%' OR erro LIKE '%http 403%' THEN 'Credencial do provedor recusada'
            WHEN erro LIKE '%http 404%' THEN 'Instância não encontrada no provedor'
            WHEN erro LIKE '%ECONNREFUSED%' OR erro LIKE '%fetch failed%' THEN 'Provedor fora do ar'
            ELSE substr(erro, 1, 60)
          END AS motivo,
          GROUP_CONCAT(DISTINCT telefone) AS telefones
        FROM whatsapp_queue
        WHERE status='erro' AND date(dataCriacao) >= date('now','-3 hours', ?)
        GROUP BY motivo ORDER BY n DESC LIMIT 10
      `, desde);

      // Conversas: o que está parado esperando gente.
      const conv = um(`
        SELECT
          SUM(CASE WHEN estado='aberta' THEN 1 ELSE 0 END) AS abertas,
          SUM(CASE WHEN estado='aberta' AND primeiraRespostaEm IS NULL THEN 1 ELSE 0 END) AS semResposta,
          SUM(CASE WHEN naoLidas > 0 THEN 1 ELSE 0 END) AS comNaoLidas,
          SUM(CASE WHEN iaAtiva=0 THEN 1 ELSE 0 END) AS iaDesligada
        FROM conv_conversas
      `);
      const tempoResposta = um(`
        SELECT ROUND(AVG((julianday(primeiraRespostaEm) - julianday(dataCriacao)) * 24 * 60)) AS minutos,
               COUNT(*) AS base
        FROM conv_conversas
        WHERE primeiraRespostaEm IS NOT NULL
          AND date(dataCriacao) >= date('now','-3 hours', ?)
      `, desde);

      // Config que decide se a IA fala. É a primeira coisa a olhar quando o
      // funil mostra todo mundo caindo na mesma porta.
      const campanhasAtivas = um(
        "SELECT COUNT(*) AS n FROM wa_campanhas WHERE status IN ('enviando','agendada')").n || 0;
      // Com vários números, a IA está "ligada" se algum número a tem ligada; o
      // escopo mostrado é o do número padrão. Sem número cadastrado, vale a
      // configuração da empresa, como antes.
      const canais = require('./whatsapp-canais');
      const numeros = canais.listarCanais(db);
      const doPadrao = require('./whatsapp-adapter').configDoAtendimento(db);
      const config = {
        canalLigado: cfg('whatsapp_enabled') === '1',
        iaLigada: numeros.length
          ? numeros.some(w => canais.getterDoCanal(w)('whatsapp_ai_enabled') === '1')
          : cfg('whatsapp_ai_enabled') === '1',
        escopo: doPadrao('whatsapp_ai_escopo') || 'todos',
        temChaveIA: !!(cfg('gemini_api_key') || cfg('openai_api_key') || cfg('anthropic_api_key')),
        campanhasAtivas,
      };

      res.json({ success: true, dias, serie, funil, erros, conversas: conv, tempoResposta, config });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

/**
 * A pausa da IA por atendimento humano: quando alguém da equipe responde à mão,
 * a IA se cala por 4 horas para não atropelar quem assumiu.
 *
 * Isto existe como função única porque a pausa era invisível. Em 30/09 um teste
 * de campanha pareceu quebrado: o lead respondeu "Sim", nada voltou, e o motivo
 * era um "bora" digitado 35 minutos antes. A tela não tinha como dizer isso, e
 * ninguém tinha como anular a pausa sem esperar as 4 horas.
 *
 * O "Retomar a IA" grava um evento na conversa (`conv_eventos`, tipo `ia`,
 * detalhe `retomada`) e a pausa passa a valer só para mensagem humana POSTERIOR
 * a ele. Evento, e não coluna nova: a tabela já existe, já guarda o histórico
 * da conversa e não exige migração em 20 bancos.
 */
const PAUSA_HUMANO_S = 4 * 3600;

/**
 * A MESMA pausa do `pausaDaIA`, escrita em SQL para a listagem (02/10/2026).
 *
 * As duas precisam concordar, e é por isso que esta constante existe em vez de
 * uma condição solta na consulta: a primeira versão olhava só "existe mensagem
 * humana nas últimas 4 h" e marcava como pausada a conversa que já tinha sido
 * retomada, ou cuja mensagem veio por outro número. O selo da lista dizia uma
 * coisa e o botão da conversa dizia outra.
 *
 * As três partes, na ordem em que importam: a mensagem é NOSSA e não é da IA;
 * entrou pela instância do número DESTA conversa; e é mais recente que a última
 * retomada, que anula o que veio antes dela.
 *
 * ── A SEGUNDA origem da pausa (02/10/2026) ────────────────────────────────
 *
 * A pausa também começa quando o SISTEMA a pede (`pausarIA`), e não só quando
 * um atendente escreve à mão: é o que acontece quando a IA diz que não sabe e
 * que alguém da equipe já vem, e quando o roteiro termina com essa promessa.
 *
 * Por que um EVENTO, e não a mensagem: a pausa se mede por mensagem nossa com
 * `from_bot = 0`, e a mensagem da IA é `from_bot = 1`. Gravá-la como humana
 * faria a pausa começar, e quebraria duas outras coisas que leem essa marca —
 * o "✓ certo / corrigir", que só aparece no que a IA escreveu, e o extrator do
 * roteiro, que lê o par pergunta→resposta. A marca diz quem falou, e mentir
 * nela para obter um efeito colateral é o começo de um defeito difícil.
 */
const DESDE_RETOMADA = `COALESCE((SELECT MAX(strftime('%s', e2.dataCriacao)) FROM conv_eventos e2
          WHERE e2.conversaId = c.id AND e2.tipo = 'ia' AND e2.detalhe LIKE 'retomada%'), 0)`;

const SQL_IA_PAUSADA = `(EXISTS (SELECT 1 FROM whatsapp_messages m2
   WHERE m2.remote_jid = c.jid AND m2.from_me = 1 AND COALESCE(m2.from_bot, 0) = 0
     AND m2.timestamp >= strftime('%s', 'now') - ${4 * 3600}
     AND (c.canalId = 0 OR m2.instance = (SELECT w3.instance FROM whatsapp_canais w3 WHERE w3.id = c.canalId))
     AND m2.timestamp > ${DESDE_RETOMADA})
  OR EXISTS (SELECT 1 FROM conv_eventos e3
   WHERE e3.conversaId = c.id AND e3.tipo = 'ia' AND e3.detalhe LIKE 'pausada%'
     AND CAST(strftime('%s', e3.dataCriacao) AS INTEGER) >= strftime('%s', 'now') - ${4 * 3600}
     AND CAST(strftime('%s', e3.dataCriacao) AS INTEGER) > ${DESDE_RETOMADA}))`;

function pausaDaIA(db, { jid, instance, canalId = null, conversaId = null }) {
  const nada = { pausada: false, ate: null, desde: null };
  try {
    // A tela chama com o canal da conversa, o envio com a instância que recebeu
    // a mensagem. Uma vira a outra aqui, senão a tela mostraria uma regra e o
    // envio aplicaria outra.
    let inst = instance;
    if (!inst && canalId) {
      const c = require('./whatsapp-canais').canalPorId(db, canalId);
      inst = c && c.instance;
    }
    if (!inst) return nada;
    const corte = Math.floor(Date.now() / 1000) - PAUSA_HUMANO_S;
    const humana = db.prepare(`SELECT MAX(timestamp) AS t FROM whatsapp_messages
      WHERE remote_jid = ? AND COALESCE(instance, ?) = ? AND from_me = 1 AND COALESCE(from_bot, 0) = 0
        AND timestamp >= ?`)
      .get(jid, inst, inst, corte).t;
    // A segunda origem: a pausa que o SISTEMA pediu (ver o comentário do
    // SQL_IA_PAUSADA). Sem conversa não há onde gravá-la, então também não há o
    // que ler.
    // O CAST não é enfeite: `strftime('%s', …)` devolve TEXT, e em SQLite uma
    // expressão TEXT comparada com número é SEMPRE maior, porque número vem
    // antes de texto na ordem de tipos. Sem ele, pausa de cinco horas atrás
    // continuava valendo para sempre (a checagem P5 reprova exatamente isso).
    // O resto da função compara com `m2.timestamp`, que é COLUNA de afinidade
    // numérica, e aí o SQLite converte o texto sozinho — é por isso que o
    // trecho antigo acerta sem CAST e este precisa dele.
    const pedida = conversaId ? db.prepare(`SELECT MAX(CAST(strftime('%s', dataCriacao) AS INTEGER)) AS t FROM conv_eventos
      WHERE conversaId = ? AND tipo = 'ia' AND detalhe LIKE 'pausada%'
        AND CAST(strftime('%s', dataCriacao) AS INTEGER) >= ?`).get(conversaId, corte).t : null;
    const ultima = Math.max(Number(humana) || 0, Number(pedida) || 0);
    if (!ultima) return nada;
    // A retomada anula o que veio antes dela. `dataCriacao` é UTC, como o
    // epoch das mensagens, então strftime('%s') compara os dois na mesma base.
    if (conversaId) {
      const r = db.prepare(`SELECT MAX(strftime('%s', dataCriacao)) AS t FROM conv_eventos
        WHERE conversaId = ? AND tipo = 'ia' AND detalhe LIKE 'retomada%'`).get(conversaId).t;
      if (r && Number(r) >= Number(ultima)) return nada;
    }
    return { pausada: true, desde: Number(ultima), ate: Number(ultima) + PAUSA_HUMANO_S };
  } catch (_) { return nada; }   // tenant sem as tabelas: sem pausa
}

/**
 * Pausa a IA nesta conversa e chama gente, quando o próprio sistema promete
 * que alguém vem (02/10/2026).
 *
 * São três efeitos, e nenhum é enfeite: a pausa com contador (o mesmo das 4 h
 * do atendimento à mão), a conversa subindo para as não lidas, e o aviso pelos
 * canais que o tenant tiver ligado. Sem eles a frase "alguém já está vindo"
 * é promessa que ninguém recebeu — e a IA responderia a próxima mensagem como
 * se nada tivesse acontecido.
 *
 * PAUSA, e não `iaAtiva = 0`: desligar é decisão de quem atende, fica até
 * alguém religar e não tem contador. Aqui o atendimento automático volta
 * sozinho em 4 h, e um clique em "Retomar" o devolve antes disso.
 *
 * O aviso é melhor esforço: canal não configurado, token errado ou provedor
 * fora do ar não podem impedir a pausa, que é a parte que o cliente sente.
 */
function pausarIA(db, conversa, { motivo = 'a IA chamou alguém', avisar = true } = {}) {
  const id = conversa && (conversa.id || conversa.conversaId);
  if (!id) return { pausada: false };
  try {
    db.prepare('INSERT INTO conv_eventos (conversaId, tipo, detalhe, usuario) VALUES (?,?,?,?)')
      .run(id, 'ia', 'pausada: ' + motivo, 'sistema');
    db.prepare('UPDATE conv_conversas SET naoLidas = naoLidas + 1 WHERE id = ?').run(id);
  } catch (e) { console.error('[conversas] pausarIA:', e.message); return { pausada: false }; }
  if (avisar) {
    const quem = (conversa.nome || conversa.telefone || 'contato') + '';
    Promise.resolve()
      .then(() => require('./notificacoes-dispatcher').enviarAlerta(db, {
        subject: 'WhatsApp: alguém precisa assumir uma conversa',
        body: `A IA pausou o atendimento de ${quem}: ${motivo}. A conversa está em Conversas, nas não lidas.`,
        logTag: 'ConversaIA',
      }))
      .catch(e => console.error('[conversas] aviso da pausa falhou:', e.message));
  }
  return { pausada: true, motivo };
}

module.exports = {
  migrarConversasDB, registrarRotasConversas, garantirConversa, registrarMensagem,
  sincronizar, acharPessoa, ESTADOS, pausaDaIA, PAUSA_HUMANO_S, mensagensDaConversa,
  pausarIA,
};
