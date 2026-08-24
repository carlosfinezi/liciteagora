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
      UNIQUE(canal, jid)
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
 * "Aguardando você": a última mensagem da conversa é deles.
 *
 * Não usa conv_conversas.primeiraRespostaEm — esse campo só é escrito pelo
 * registrarMensagem, e nem o disparo de campanha nem a resposta da IA passam
 * por ele (gravam direto em whatsapp_messages). No 1bit o campo aponta 817
 * conversas sem resposta onde o fato são 45.
 */
const AGUARDANDO_SQL = `(SELECT m.from_me FROM whatsapp_messages m
   WHERE m.remote_jid = c.jid ORDER BY m.id DESC LIMIT 1) = 0`;

/**
 * Telefones que responderam a uma campanha de WhatsApp (todas, se campanhaId
 * for nulo).
 *
 * A fonte NÃO é só wa_campanha_dest.status = 'respondeu': essa marca só é
 * gravada pelo webhook quando a linha ainda está em 'enviado', e nasceu depois
 * dos primeiros disparos — no 1bit ela cobria 2 das 55 respostas reais. O
 * critério aqui é o fato observável, que vale para trás: chegou mensagem do
 * lead depois de a campanha ter enviado para ele.
 */
function telefonesQueResponderam(db, campanhaId) {
  if (!temTabela(db, 'wa_campanha_dest') || !temTabela(db, 'whatsapp_messages')) return null;
  let sql = `SELECT DISTINCT d.telefone FROM wa_campanha_dest d
    WHERE d.enviado_em IS NOT NULL AND d.telefone IS NOT NULL`;
  const args = [];
  if (campanhaId) { sql += ' AND d.campanha_id = ?'; args.push(campanhaId); }
  sql += ` AND (d.status = 'respondeu' OR EXISTS (
      SELECT 1 FROM whatsapp_messages m
       WHERE m.from_me = 0 AND m.timestamp > strftime('%s', d.enviado_em)
         AND (m.remote_jid = d.jid OR m.remote_jid = d.telefone || '@s.whatsapp.net')))`;
  try { return db.prepare(sql).all(...args).map(r => r.telefone); }
  catch { return null; }
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
    const r = db.prepare(`SELECT id, razaoSocial FROM pessoas
      WHERE ativo = 1 AND replace(replace(replace(replace(COALESCE(telefone,''),'(',''),')',''),'-',''),' ','') LIKE ?
      LIMIT 1`).get('%' + fim);
    return r || null;
  } catch { return null; }
}

/**
 * Garante que existe conversa para o jid e devolve o id. Chamado tanto pela
 * tela quanto pelo webhook — por isso é idempotente.
 */
function garantirConversa(db, { jid, nome = null, canal = 'whatsapp' }) {
  migrarConversasDB(db);
  const existente = db.prepare('SELECT id, pessoaId FROM conv_conversas WHERE canal = ? AND jid = ?').get(canal, jid);
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
  return db.prepare(`INSERT INTO conv_conversas (canal, jid, telefone, nome, pessoaId, estado)
    VALUES (?, ?, ?, ?, ?, 'aberta')`)
    .run(canal, jid, telefone, p ? p.razaoSocial : (nome || null), p ? p.id : null).lastInsertRowid;
}

/** Chamado quando chega ou sai mensagem: mantém o resumo da conversa em dia. */
function registrarMensagem(db, { jid, texto, deMim, nome = null }) {
  try {
    const id = garantirConversa(db, { jid, nome });
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

// Sincroniza conversas a partir das mensagens que já existem. Roda uma vez por
// abertura de tela e é barato: só olha o que entrou depois da última conversa.
function sincronizar(db) {
  migrarConversasDB(db);
  let jids = [];
  try {
    jids = db.prepare(`SELECT remote_jid jid,
        MAX(timestamp) ts,
        (SELECT texto FROM whatsapp_messages x WHERE x.remote_jid = m.remote_jid AND texto IS NOT NULL ORDER BY id DESC LIMIT 1) ultimo,
        -- Só de mensagem RECEBIDA: no que sai, o push_name é o do dono da
        -- instância, e a conversa acabava batizada com o nome de quem atende.
        (SELECT push_name FROM whatsapp_messages x WHERE x.remote_jid = m.remote_jid AND x.from_me = 0 AND push_name IS NOT NULL ORDER BY id DESC LIMIT 1) nome,
        (SELECT from_me FROM whatsapp_messages x WHERE x.remote_jid = m.remote_jid ORDER BY id DESC LIMIT 1) ultimoDeMim
      FROM whatsapp_messages m WHERE remote_jid IS NOT NULL AND remote_jid <> 'status@broadcast'
        AND remote_jid NOT LIKE '%@g.us'
      GROUP BY remote_jid`).all();
  } catch { return 0; }

  let novas = 0;
  for (const j of jids) {
    const antes = db.prepare('SELECT id, ultimaEm FROM conv_conversas WHERE canal = ? AND jid = ?').get('whatsapp', j.jid);
    if (!antes) {
      const id = garantirConversa(db, { jid: j.jid, nome: j.nome });
      db.prepare(`UPDATE conv_conversas SET ultimaMensagem = ?, nome = COALESCE(nome, ?),
          ultimaEm = datetime(?, 'unixepoch') WHERE id = ?`)
        .run(String(j.ultimo || '').slice(0, 300), j.nome, j.ts || Math.floor(Date.now() / 1000), id);
      novas++;
    }
  }
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
      // 'todas' ou o id de uma campanha; vazio desliga o recorte.
      const campanha = String(req.query.campanha || '');
      // O filtro é sempre calculado, esteja ligado ou não: é ele que alimenta a
      // contagem do próprio botão que o liga.
      const respondentes = telefonesQueResponderam(db,
        /^\d+$/.test(campanha) ? Number(campanha) : null);

      let sql = `SELECT c.*, p.razaoSocial AS pessoaNome FROM conv_conversas c
        LEFT JOIN pessoas p ON p.id = c.pessoaId`;
      const onde = [];
      const args = [];
      if (ESTADOS.includes(estado)) { onde.push('c.estado = ?'); args.push(estado); }
      if (recorte === 'naoLidas') onde.push('c.naoLidas > 0');
      if (recorte === 'aguardando' && temMensagens) onde.push(AGUARDANDO_SQL);
      if (campanha) {
        const tels = respondentes || [];
        if (!tels.length) onde.push('0');
        else { onde.push(`c.telefone IN (${tels.map(() => '?').join(',')})`); args.push(...tels); }
      }
      if (onde.length) sql += ' WHERE ' + onde.join(' AND ');
      sql += ' ORDER BY c.ultimaEm DESC NULLS LAST, c.id DESC LIMIT 300';
      let linhas = db.prepare(sql).all(...args);
      if (q) linhas = linhas.filter(c => [c.nome, c.pessoaNome, c.telefone, c.ultimaMensagem]
        .some(v => String(v || '').toLowerCase().includes(q)));

      const contagem = {};
      for (const e of ESTADOS) {
        contagem[e] = db.prepare('SELECT COUNT(*) n FROM conv_conversas WHERE estado = ?').get(e).n;
      }
      contagem.total = db.prepare('SELECT COUNT(*) n FROM conv_conversas').get().n;
      contagem.naoLidas = db.prepare('SELECT COUNT(*) n FROM conv_conversas WHERE naoLidas > 0').get().n;
      contagem.aguardando = temMensagens
        ? db.prepare(`SELECT COUNT(*) n FROM conv_conversas c WHERE ${AGUARDANDO_SQL}`).get().n : 0;
      contagem.respondeuCampanha = respondentes && respondentes.length
        ? db.prepare(`SELECT COUNT(*) n FROM conv_conversas
            WHERE telefone IN (${respondentes.map(() => '?').join(',')})`).get(...respondentes).n
        : 0;
      res.json({ success: true, conversas: linhas.map(c => ({ ...c, etiquetas: jsonOu(c.etiquetas, []) })), contagem });
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
        for (const c of db.prepare('SELECT * FROM comm_campanhas ORDER BY id DESC LIMIT 100').all()) {
          linhas.push({ origem: 'comm', id: c.id, nome: c.nome, status: c.status,
                        canal: c.canal || null, criadoEm: c.dataCriacao || null, destinatarios: null,
                        totalDestinatarios: c.totalDestinatarios, tipo: c.tipo || null,
                        agendadaPara: c.agendadaPara || null });
        }
      } catch { /* tenant sem o módulo antigo */ }
      try {
        for (const c of db.prepare('SELECT * FROM wa_campanhas ORDER BY id DESC LIMIT 100').all()) {
          const cfg = jsonOu(c.config, {});
          const dest = db.prepare(`SELECT status, COUNT(*) n FROM wa_campanha_dest
            WHERE campanha_id = ? GROUP BY status`).all(c.id);
          linhas.push({ origem: 'wa', id: c.id, nome: c.nome || cfg.nome, status: c.status,
                        canal: 'whatsapp', criadoEm: c.criado_em || null,
                        descricao: cfg.descricao || null, agendadaPara: cfg.agendadaPara || null,
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
  app.get('/api/conversas/publico', (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const f = {
        uf: String(req.query.uf || '').trim().toUpperCase(),
        cidade: String(req.query.cidade || '').trim().toLowerCase(),
        marketing: String(req.query.marketing || ''),      // '1' aceita | '0' não aceita
        compraram: String(req.query.compraram || ''),      // '1' com pedido | '0' sem pedido
        tag: String(req.query.tag || '').trim().toLowerCase(),
      };
      let linhas = db.prepare(`SELECT id, razaoSocial, nomeFantasia, telefone, cidade, uf,
             COALESCE(categorias,'') AS categorias, COALESCE(tags,'') AS tags,
             COALESCE(aceitaWhatsappMarketing, 0) AS aceitaMarketing,
             (SELECT COUNT(*) FROM pedidos ped WHERE ped.clienteId = pessoas.id) AS pedidos
        FROM pessoas
        WHERE ativo = 1 AND TRIM(COALESCE(telefone,'')) <> ''
        ORDER BY razaoSocial LIMIT 2000`).all();

      if (q) linhas = linhas.filter(p => [p.razaoSocial, p.nomeFantasia, p.telefone, p.cidade]
        .some(v => String(v || '').toLowerCase().includes(q)));
      if (f.uf) linhas = linhas.filter(p => String(p.uf || '').toUpperCase() === f.uf);
      if (f.cidade) linhas = linhas.filter(p => String(p.cidade || '').toLowerCase().includes(f.cidade));
      if (f.marketing === '1') linhas = linhas.filter(p => p.aceitaMarketing);
      if (f.marketing === '0') linhas = linhas.filter(p => !p.aceitaMarketing);
      if (f.compraram === '1') linhas = linhas.filter(p => p.pedidos > 0);
      if (f.compraram === '0') linhas = linhas.filter(p => !p.pedidos);
      if (f.tag) linhas = linhas.filter(p => (p.categorias + ' ' + p.tags).toLowerCase().includes(f.tag));

      // Opt-out casa por destino normalizado — mesmo critério do envio.
      let fora = new Set();
      try {
        fora = new Set(db.prepare("SELECT destino FROM comm_optout WHERE canal = 'whatsapp'")
          .all().map(r => soDigitos(r.destino).slice(-8)));
      } catch { }
      // Opções para os selects saem do que existe de fato no cadastro.
      const todas = db.prepare(`SELECT DISTINCT uf FROM pessoas
        WHERE ativo = 1 AND TRIM(COALESCE(uf,'')) <> '' ORDER BY uf`).all().map(r => r.uf);
      res.json({ success: true, ufs: todas, total: linhas.length, pessoas: linhas.map(p => ({
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
      res.json({ success: true, campanha: { ...c, config: jsonOu(c.config, {}) }, destinatarios: dest });
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

  /** Oportunidades sem conversa ligada, para o vendedor escolher qual vincular. */
  app.get('/api/conversas/oportunidades/livres', (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      let linhas = db.prepare(`SELECT o.id, o.titulo, o.valor, e.nome AS etapaNome, p.razaoSocial AS clienteNome
        FROM crm_oportunidades o
        LEFT JOIN crm_etapas e ON e.id = o.etapaId
        LEFT JOIN pessoas p ON p.id = o.clienteId
        WHERE o.ativo = 1 AND o.id NOT IN (SELECT COALESCE(oportunidadeId,0) FROM conv_conversas)
        ORDER BY o.id DESC LIMIT 100`).all();
      if (q) linhas = linhas.filter(o => [o.titulo, o.clienteNome].some(v => String(v||'').toLowerCase().includes(q)));
      res.json({ success: true, oportunidades: linhas });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ---------- uma conversa, com o que o ERP sabe do contato ----------
  app.get('/api/conversas/:id', (req, res) => {
    try {
      const c = db.prepare(`SELECT c.*, p.razaoSocial AS pessoaNome, p.cpfCnpj, p.email, p.cidade, p.uf
        FROM conv_conversas c LEFT JOIN pessoas p ON p.id = c.pessoaId WHERE c.id = ?`).get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });

      let mensagens = [];
      try {
        // As 400 ÚLTIMAS, não as 400 primeiras: o corte era por id ASC, então
        // conversa longa abria no começo do histórico e o atendente nunca via
        // o que acabou de chegar. A ordem final volta a ser cronológica.
        //
        // O veredito vem junto para a tela mostrar o que já foi avaliado: sem
        // isso, reabrir a conversa apaga o rastro do que o atendente revisou.
        mensagens = db.prepare(`SELECT * FROM (
            SELECT m.id, m.from_me, m.from_bot, m.texto, m.message_type, m.timestamp,
              (SELECT veredito FROM ia_correcoes x WHERE x.mensagemId = m.id ORDER BY x.id DESC LIMIT 1) AS veredito
            FROM whatsapp_messages m WHERE m.remote_jid = ? ORDER BY m.id DESC LIMIT 400
          ) ORDER BY id ASC`).all(c.jid);
      } catch { /* sem tabela de mensagens ainda */ }

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
      res.json({ success: true, conversa: { ...c, etiquetas: jsonOu(c.etiquetas, []) }, mensagens, ficha });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ---------- responder ----------
  app.post('/api/conversas/:id/responder', async (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
      const texto = String(req.body?.texto || '').trim();
      if (!texto) return res.status(400).json({ success: false, error: 'Escreva a mensagem' });

      const { enviarWhatsApp } = require('./whatsapp-adapter');
      // ignorarRitmo: é resposta a quem escreveu, não disparo.
      const r = await enviarWhatsApp(db, { telefone: c.telefone, texto, ignorarRitmo: true });
      if (r.error) return res.status(400).json({ success: false, error: r.error });

      try {
        db.prepare(`INSERT OR IGNORE INTO whatsapp_messages (wa_message_id, remote_jid, from_me, texto, timestamp)
          VALUES (?,?,1,?,?)`).run(r.providerMessageId || null, c.jid, texto, Math.floor(Date.now() / 1000));
      } catch { }
      registrarMensagem(db, { jid: c.jid, texto, deMim: true });
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
        db.prepare('UPDATE conv_conversas SET donoId = ? WHERE id = ?').run(b.donoId || null, c.id);
        evento(c.id, 'dono', String(b.donoId || 'ninguém'), req);
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
      const config = {
        canalLigado: cfg('whatsapp_enabled') === '1',
        iaLigada: cfg('whatsapp_ai_enabled') === '1',
        escopo: cfg('whatsapp_ai_escopo') || 'todos',
        temChaveIA: !!(cfg('gemini_api_key') || cfg('openai_api_key') || cfg('anthropic_api_key')),
        campanhasAtivas,
      };

      res.json({ success: true, dias, serie, funil, erros, conversas: conv, tempoResposta, config });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

module.exports = {
  migrarConversasDB, registrarRotasConversas, garantirConversa, registrarMensagem,
  sincronizar, acharPessoa, ESTADOS,
};
