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
}

const jsonOu = (t, p) => { try { return t ? JSON.parse(t) : p; } catch { return p; } };
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

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
        (SELECT push_name FROM whatsapp_messages x WHERE x.remote_jid = m.remote_jid AND push_name IS NOT NULL ORDER BY id DESC LIMIT 1) nome,
        (SELECT from_me FROM whatsapp_messages x WHERE x.remote_jid = m.remote_jid ORDER BY id DESC LIMIT 1) ultimoDeMim
      FROM whatsapp_messages m WHERE remote_jid IS NOT NULL AND remote_jid <> 'status@broadcast'
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
      let sql = `SELECT c.*, p.razaoSocial AS pessoaNome FROM conv_conversas c
        LEFT JOIN pessoas p ON p.id = c.pessoaId`;
      const args = [];
      if (ESTADOS.includes(estado)) { sql += ' WHERE c.estado = ?'; args.push(estado); }
      sql += ' ORDER BY c.ultimaEm DESC NULLS LAST, c.id DESC LIMIT 300';
      let linhas = db.prepare(sql).all(...args);
      if (q) linhas = linhas.filter(c => [c.nome, c.pessoaNome, c.telefone, c.ultimaMensagem]
        .some(v => String(v || '').toLowerCase().includes(q)));

      const contagem = {};
      for (const e of ESTADOS) {
        contagem[e] = db.prepare('SELECT COUNT(*) n FROM conv_conversas WHERE estado = ?').get(e).n;
      }
      res.json({ success: true, conversas: linhas.map(c => ({ ...c, etiquetas: jsonOu(c.etiquetas, []) })), contagem });
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
        mensagens = db.prepare(`SELECT id, from_me, from_bot, texto, message_type, timestamp
          FROM whatsapp_messages WHERE remote_jid = ? ORDER BY id ASC LIMIT 400`).all(c.jid);
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
      db.prepare(`INSERT INTO ia_correcoes (conversaId, perguntou, respondeu, correta, viraBase, baseId, usuario)
        VALUES (?,?,?,?,?,?,?)`)
        .run(b.conversaId || null, String(b.perguntou || '').slice(0, 1000),
             String(b.respondeu || '').slice(0, 2000), correta.slice(0, 4000),
             b.viraBase === false ? 0 : 1, baseId, usuario(req));
      res.json({ success: true, baseId });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

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
                        canal: c.canal || null, criadoEm: c.dataCriacao || null, destinatarios: null });
        }
      } catch { /* tenant sem o módulo antigo */ }
      try {
        for (const c of db.prepare('SELECT * FROM wa_campanhas ORDER BY id DESC LIMIT 100').all()) {
          const cfg = jsonOu(c.config, {});
          const dest = db.prepare(`SELECT status, COUNT(*) n FROM wa_campanha_dest
            WHERE campanha_id = ? GROUP BY status`).all(c.id);
          linhas.push({ origem: 'wa', id: c.id, nome: c.nome || cfg.nome, status: c.status,
                        canal: 'whatsapp', criadoEm: c.criado_em || null,
                        descricao: cfg.descricao || null,
                        destinatarios: dest.reduce((o, d) => (o[d.status] = d.n, o), {}) });
        }
      } catch { }
      res.json({ success: true, campanhas: linhas });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
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
}

module.exports = {
  migrarConversasDB, registrarRotasConversas, garantirConversa, registrarMensagem,
  sincronizar, acharPessoa, ESTADOS,
};
