/**
 * Roteiros de venda: o roteiro, a visita e o resumo.
 *
 * ── O recorte do vendedor ──────────────────────────────────────────────────
 *
 * Quem preenche a visita é vendedor comissionado, em campo. Ele vê as próprias
 * visitas e só. O recorte segue o que o sistema já faz com pedido: `ehVendedor`
 * no usuário decide, e a listagem filtra por `vendedorId`. Sem isso, a carteira
 * de um apareceria para o outro.
 *
 * ── Por que o resumo é gerado no servidor ──────────────────────────────────
 *
 * Ele é o passo que mais falha no papel. Montá-lo na tela deixaria cada
 * navegador com uma versão, e o que chega a quem fecha a venda precisa ser
 * sempre o mesmo texto, com os mesmos itens, na mesma ordem.
 */
const R = require('./roteiros');

function registrarRotasRoteiros(app, db) {
  const tdb = (req) => req.tenantDb || db;
  const jsonOu = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
  const souVendedor = (req) => !!(req.user && req.user.ehVendedor);
  const meuId = (req) => (req.user && req.user.id) || null;

  const empresaDe = (d) => {
    try { return d.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {}; }
    catch { return {}; }
  };
  const configDe = (linha) => { try { return JSON.parse(linha.config); } catch { return {}; } };

  /** O roteiro com as variáveis já trocadas: é assim que ele é lido na loja. */
  function roteiroResolvido(d, linha, req) {
    const cfg = configDe(linha);
    // Sem nome do usuário, o marcador aparece em vez da variável crua: o
    // vendedor lê esta frase em voz alta, e "{{vendedorNome}}" no meio dela é
    // pior do que um lembrete de que falta preencher o cadastro.
    const ctx = { empresa: empresaDe(d), valores: cfg.valores || {},
                  contexto: { vendedorNome: (req.user && (req.user.nome || req.user.username)) || '[seu nome]' } };
    const texto = (v) => (typeof v === 'string' ? R.render(v, ctx) : v);
    return {
      id: linha.id, nome: linha.nome, canal: linha.canal, corte: linha.corte,
      porte: cfg.porte || null,
      abertura: texto(cfg.abertura),
      perguntas: (cfg.perguntas || []).map(p => ({ ...p, texto: texto(p.texto), nota: texto(p.nota) })),
      video: cfg.video ? { chamada: texto(cfg.video.chamada), instrucao: texto(cfg.video.instrucao) } : null,
      agendamento: cfg.agendamento
        ? { texto: texto(cfg.agendamento.texto), instrucao: texto(cfg.agendamento.instrucao) } : null,
      objecoes: (cfg.objecoes || []).map(o => ({ ...o, resposta: texto(o.resposta), regra: texto(o.regra) })),
      metas: cfg.metas || null,
    };
  }

  app.get('/api/roteiros', (req, res) => {
    const d = tdb(req);
    try {
      const canal = String(req.query.canal || '');
      const linhas = d.prepare(`SELECT id, nome, canal, corte, padrao, ativo, dataAtualizacao
        FROM roteiros WHERE ativo = 1 ${canal ? 'AND canal = ?' : ''} ORDER BY padrao DESC, nome`)
        .all(...(canal ? [canal] : []));
      res.json({ success: true, roteiros: linhas });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  /** O roteiro pronto para ser seguido. `id=padrao` pega o da casa. */
  app.get('/api/roteiros/:id', (req, res) => {
    const d = tdb(req);
    try {
      const linha = req.params.id === 'padrao'
        ? d.prepare("SELECT * FROM roteiros WHERE ativo = 1 AND canal = 'visita' ORDER BY padrao DESC, id LIMIT 1").get()
        : d.prepare('SELECT * FROM roteiros WHERE id = ?').get(req.params.id);
      if (!linha) return res.status(404).json({ success: false, error: 'Roteiro não encontrado' });
      res.json({ success: true, roteiro: roteiroResolvido(d, linha, req) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.put('/api/roteiros/:id', (req, res) => {
    const d = tdb(req);
    try {
      const linha = d.prepare('SELECT * FROM roteiros WHERE id = ?').get(req.params.id);
      if (!linha) return res.status(404).json({ success: false, error: 'Roteiro não encontrado' });
      const cfg = req.body?.config;
      if (cfg) {
        const problemas = R.validar(cfg);
        // Recusa em vez de gravar: o texto é lido em voz alta na frente do
        // cliente, e variável sem valor viraria um buraco no meio da frase.
        if (problemas.length) return res.status(400).json({ success: false, error: problemas[0], problemas });
        d.prepare(`UPDATE roteiros SET config = ?, corte = ?, dataAtualizacao = datetime('now')
          WHERE id = ?`).run(JSON.stringify(cfg), Number(cfg.corte) || linha.corte, linha.id);
      }
      if (req.body?.nome) d.prepare('UPDATE roteiros SET nome = ? WHERE id = ?').run(String(req.body.nome).slice(0, 120), linha.id);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // ==================== as visitas ====================

  const CAMPOS = ['empresa', 'segmento', 'decisor', 'whatsapp', 'contador', 'caixas',
                  'funcionarios', 'maisDeUmPonto', 'videoAssistido', 'reacaoVideo',
                  'objecao', 'status', 'motivo', 'pessoaId'];

  app.get('/api/visitas', (req, res) => {
    const d = tdb(req);
    try {
      // O vendedor vê as dele. Quem não é vendedor (gerência) vê todas.
      const so = souVendedor(req) ? 'WHERE v.vendedorId = @eu' : '';
      const linhas = d.prepare(`SELECT v.*, COALESCE(u.nome, u.username) AS vendedorNome
        FROM roteiro_visitas v LEFT JOIN users u ON u.id = v.vendedorId
        ${so} ORDER BY v.id DESC LIMIT 200`).all({ eu: meuId(req) });
      res.json({ success: true, visitas: linhas.map(v => ({ ...v, respostas: jsonOu(v.respostas) })) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/visitas', (req, res) => {
    const d = tdb(req);
    try {
      const roteiro = req.body?.roteiroId
        ? d.prepare('SELECT * FROM roteiros WHERE id = ?').get(req.body.roteiroId)
        : d.prepare("SELECT * FROM roteiros WHERE ativo = 1 AND canal = 'visita' ORDER BY padrao DESC, id LIMIT 1").get();
      if (!roteiro) return res.status(400).json({ success: false, error: 'Nenhum roteiro de visita cadastrado' });
      const r = d.prepare(`INSERT INTO roteiro_visitas (roteiroId, vendedorId, empresa)
        VALUES (?,?,?)`).run(roteiro.id, meuId(req), String(req.body?.empresa || '').slice(0, 150) || null);
      res.json({ success: true, id: r.lastInsertRowid, roteiroId: roteiro.id });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.put('/api/visitas/:id', (req, res) => {
    const d = tdb(req);
    try {
      const v = d.prepare('SELECT * FROM roteiro_visitas WHERE id = ?').get(req.params.id);
      if (!v) return res.status(404).json({ success: false, error: 'Visita não encontrada' });
      if (souVendedor(req) && v.vendedorId && v.vendedorId !== meuId(req)) {
        return res.status(403).json({ success: false, error: 'Esta visita é de outro vendedor' });
      }
      const roteiro = d.prepare('SELECT * FROM roteiros WHERE id = ?').get(v.roteiroId);
      const cfg = roteiro ? configDe(roteiro) : {};

      const sets = [], vals = {};
      for (const c of CAMPOS) {
        if (req.body[c] === undefined) continue;
        sets.push(`${c} = @${c}`);
        vals[c] = ['caixas', 'funcionarios', 'pessoaId'].includes(c) ? (Number(req.body[c]) || null)
          : ['maisDeUmPonto', 'videoAssistido'].includes(c) ? (req.body[c] ? 1 : 0)
          : (req.body[c] === null ? null : String(req.body[c]).slice(0, 300));
      }
      if (req.body.status !== undefined && !R.STATUS.includes(String(req.body.status))) {
        return res.status(400).json({ success: false, error: 'Situação inválida' });
      }
      if (req.body.respostas !== undefined) {
        const marcado = req.body.respostas || {};
        const p = R.pontuar(cfg, marcado);
        // A pontuação é gravada junto: o peso pode mudar amanhã, e a visita de
        // ontem tem de continuar valendo o que valia quando foi feita.
        sets.push('respostas = @respostas', 'pontos = @pontos');
        vals.respostas = JSON.stringify(marcado);
        vals.pontos = p.pontos;
      }
      if (!sets.length) return res.json({ success: true });
      sets.push("dataAtualizacao = datetime('now')");
      d.prepare(`UPDATE roteiro_visitas SET ${sets.join(', ')} WHERE id = @id`).run({ ...vals, id: v.id });

      const atual = d.prepare('SELECT * FROM roteiro_visitas WHERE id = ?').get(v.id);
      const p = R.pontuar(cfg, jsonOu(atual.respostas));
      res.json({ success: true, pontos: p.pontos, maximo: p.maximo, qualificado: p.qualificado,
                 faltam: p.faltam, temPorte: R.temPorte(cfg, atual) });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /** O resumo pronto. `enviar=1` manda para quem fecha a venda e carimba. */
  app.post('/api/visitas/:id/resumo', (req, res) => {
    const d = tdb(req);
    try {
      const v = d.prepare('SELECT * FROM roteiro_visitas WHERE id = ?').get(req.params.id);
      if (!v) return res.status(404).json({ success: false, error: 'Visita não encontrada' });
      const roteiro = d.prepare('SELECT * FROM roteiros WHERE id = ?').get(v.roteiroId);
      const cfg = roteiro ? configDe(roteiro) : {};

      let quando = null;
      if (v.agendaReuniaoId) {
        try {
          const a = d.prepare('SELECT dataHora FROM agenda_reunioes WHERE id = ?').get(v.agendaReuniaoId);
          if (a?.dataHora) quando = require('./agenda-reuniao').porExtenso(a.dataHora);
        } catch (_) { }
      }
      const texto = R.resumo(cfg, { ...v, respostas: jsonOu(v.respostas) }, { quando });
      if (!req.body?.enviar) return res.json({ success: true, texto });

      const destino = String(req.body?.destino || '').trim();
      if (!destino) return res.status(400).json({ success: false, error: 'Informe o WhatsApp de quem recebe' });
      // `.catch` e não try/catch: `enviarWhatsApp` é async, e a rejeição que um
      // try/catch não pega derrubaria o processo com a visita já gravada.
      Promise.resolve()
        .then(() => require('./whatsapp-adapter').enviarWhatsApp(d, { telefone: destino, texto }))
        .catch((e) => console.error('[Roteiro] resumo não saiu:', e.message));
      d.prepare("UPDATE roteiro_visitas SET resumoEnviadoEm = datetime('now') WHERE id = ?").run(v.id);
      res.json({ success: true, texto, enviado: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * Preenche o roteiro a partir da conversa, com a IA.
   *
   * A resposta do modelo passa por `conferirExtracao` antes de virar dado: id
   * que não existe no roteiro e trecho que não está na conversa são recusados.
   * Essa segunda checagem é o que transforma "cite a fonte" de pedido educado
   * em regra — o modelo pode escrever qualquer coisa no campo, mas o texto
   * precisa existir de verdade no histórico.
   *
   * A pontuação continua saindo da tabela de pesos. A IA classifica; ela não
   * dá nota.
   */
  app.post('/api/conversas/:id/qualificar', async (req, res) => {
    const d = tdb(req);
    try {
      const conversa = d.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(req.params.id);
      if (!conversa) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });

      // Qual roteiro vale: o da campanha de onde o contato veio, e na falta
      // dela o padrão da empresa. Quem chega por fora de campanha (indicação,
      // site, cliente antigo) é a maior parte das conversas, e ficaria sem
      // qualificação nenhuma se só a campanha decidisse.
      // A conversa não guarda a campanha: ela é descoberta pelo telefone em
      // `wa_campanha_dest`, com `enviado_em` preenchido. É a mesma consulta do
      // webhook, e a condição de envio importa — estar numa fila de dezenas de
      // milhares de pendentes não é ter sido abordado.
      let roteiro = null;
      try {
        const num = String(conversa.jid || '').split('@')[0] || conversa.telefone;
        const dest = d.prepare(`SELECT campanha_id FROM wa_campanha_dest
          WHERE (telefone = ? OR jid = ?) AND enviado_em IS NOT NULL
          ORDER BY id DESC LIMIT 1`).get(num, conversa.jid);
        if (dest) {
          const cfgCamp = d.prepare('SELECT config FROM wa_campanhas WHERE id = ?').get(dest.campanha_id);
          const idRoteiro = cfgCamp ? jsonOu(cfgCamp.config).roteiro_id : null;
          if (idRoteiro) roteiro = d.prepare('SELECT * FROM roteiros WHERE id = ? AND ativo = 1').get(idRoteiro);
        }
      } catch (_) { /* tenant sem campanha legado */ }
      if (!roteiro) {
        roteiro = d.prepare(`SELECT * FROM roteiros WHERE ativo = 1 AND canal = 'whatsapp'
          ORDER BY padrao DESC, id LIMIT 1`).get();
      }
      if (!roteiro) return res.status(400).json({ success: false, error: 'Nenhum roteiro de WhatsApp cadastrado' });
      const cfg = configDe(roteiro);

      const historico = d.prepare(`SELECT from_me AS deMim, texto FROM whatsapp_messages
        WHERE remote_jid = ? ORDER BY timestamp DESC LIMIT 40`).all(conversa.jid || conversa.telefone)
        .reverse().map(m => ({ deMim: !!m.deMim, texto: m.texto }));
      if (historico.length < 2) {
        return res.status(400).json({ success: false, error: 'Conversa curta demais para qualificar' });
      }

      let visita = d.prepare('SELECT * FROM roteiro_visitas WHERE conversaId = ? ORDER BY id DESC LIMIT 1')
        .get(conversa.id);
      const jaTem = visita ? jsonOu(visita.respostas) : {};
      const { prompt, faltam } = R.promptExtracao(cfg, historico, jaTem);
      if (!faltam.length) {
        const p = R.pontuar(cfg, jaTem);
        return res.json({ success: true, nada: true, pontos: p.pontos, maximo: p.maximo });
      }

      const chave = d.prepare("SELECT valor FROM config WHERE chave = 'gemini_api_key'").get()?.valor;
      if (!chave) return res.status(400).json({ success: false, error: 'Sem chave do Gemini configurada' });
      const modelo = require('./ia-modelos').resolverModelo(d, 'gemini');
      const bruto = await require('./analise-ia').chamarGemini(chave, prompt, modelo, 1);
      if (!bruto) return res.status(502).json({ success: false, error: 'A IA não respondeu' });

      const { aceitas, recusadas } = R.conferirExtracao(cfg, bruto, historico);
      const respostas = { ...jaTem };
      for (const [k, v] of Object.entries(aceitas)) respostas[k] = v.resposta;
      const p = R.pontuar(cfg, respostas);

      if (!visita) {
        const r = d.prepare(`INSERT INTO roteiro_visitas (roteiroId, conversaId, pessoaId, empresa,
            whatsapp, respostas, pontos) VALUES (?,?,?,?,?,?,?)`)
          .run(roteiro.id, conversa.id, conversa.pessoaId || null, conversa.nome || null,
               conversa.telefone || null, JSON.stringify(respostas), p.pontos);
        visita = { id: r.lastInsertRowid };
      } else {
        d.prepare(`UPDATE roteiro_visitas SET respostas = ?, pontos = ?,
          dataAtualizacao = datetime('now') WHERE id = ?`)
          .run(JSON.stringify(respostas), p.pontos, visita.id);
      }
      // As recusas voltam para a tela: é o que mostra quando o modelo tentou
      // preencher o que ninguém disse.
      res.json({ success: true, visitaId: visita.id, aceitas, recusadas,
                 pontos: p.pontos, maximo: p.maximo, qualificado: p.qualificado, faltam: p.faltam });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  /** O que a IA já conseguiu apurar desta conversa. */
  app.get('/api/conversas/:id/qualificacao', (req, res) => {
    const d = tdb(req);
    try {
      const v = d.prepare('SELECT * FROM roteiro_visitas WHERE conversaId = ? ORDER BY id DESC LIMIT 1')
        .get(req.params.id);
      if (!v) {
        const padrao = d.prepare("SELECT * FROM roteiros WHERE ativo = 1 AND canal = 'whatsapp' ORDER BY padrao DESC, id LIMIT 1").get();
        return res.json({ success: true, visita: null,
          perguntas: padrao ? (configDe(padrao).perguntas || []) : [] });
      }
      const roteiro = d.prepare('SELECT * FROM roteiros WHERE id = ?').get(v.roteiroId);
      const cfg = roteiro ? configDe(roteiro) : {};
      const p = R.pontuar(cfg, jsonOu(v.respostas));
      res.json({ success: true, visita: { ...v, respostas: jsonOu(v.respostas) },
                 perguntas: cfg.perguntas || [],
                 pontos: p.pontos, maximo: p.maximo, qualificado: p.qualificado,
                 respondidas: p.respondidas, faltam: p.faltam, dores: p.dores });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  /**
   * O atendente confirma ou corrige o que a IA apurou.
   *
   * A correção vence a extração e não é revisitada: a próxima passada da IA só
   * pergunta o que ainda está em branco. É o mesmo desenho do "corrigir" que
   * alimenta a Base da IA — quem trabalha na conversa tem a última palavra.
   */
  app.put('/api/conversas/:id/qualificacao', (req, res) => {
    const d = tdb(req);
    try {
      const conversa = d.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(req.params.id);
      if (!conversa) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
      let v = d.prepare('SELECT * FROM roteiro_visitas WHERE conversaId = ? ORDER BY id DESC LIMIT 1')
        .get(conversa.id);
      const roteiro = v
        ? d.prepare('SELECT * FROM roteiros WHERE id = ?').get(v.roteiroId)
        : d.prepare("SELECT * FROM roteiros WHERE ativo = 1 AND canal = 'whatsapp' ORDER BY padrao DESC, id LIMIT 1").get();
      if (!roteiro) return res.status(400).json({ success: false, error: 'Nenhum roteiro de WhatsApp cadastrado' });
      const cfg = configDe(roteiro);

      const respostas = { ...(v ? jsonOu(v.respostas) : {}) };
      for (const [chave, valor] of Object.entries(req.body?.respostas || {})) {
        const p = (cfg.perguntas || []).find(x => x.chave === chave);
        if (!p) return res.status(400).json({ success: false, error: `Pergunta desconhecida: ${chave}` });
        if (valor === null || valor === '') { delete respostas[chave]; continue; }
        if (!(p.opcoes || []).some(o => o.id === valor)) {
          return res.status(400).json({ success: false, error: `Resposta desconhecida em ${chave}: ${valor}` });
        }
        respostas[chave] = valor;
      }
      const pt = R.pontuar(cfg, respostas);
      if (!v) {
        const r = d.prepare(`INSERT INTO roteiro_visitas (roteiroId, conversaId, pessoaId, empresa,
            whatsapp, respostas, pontos) VALUES (?,?,?,?,?,?,?)`)
          .run(roteiro.id, conversa.id, conversa.pessoaId || null, conversa.nome || null,
               conversa.telefone || null, JSON.stringify(respostas), pt.pontos);
        v = { id: r.lastInsertRowid };
      } else {
        d.prepare(`UPDATE roteiro_visitas SET respostas = ?, pontos = ?,
          dataAtualizacao = datetime('now') WHERE id = ?`)
          .run(JSON.stringify(respostas), pt.pontos, v.id);
      }
      res.json({ success: true, visitaId: v.id, pontos: pt.pontos, maximo: pt.maximo,
                 qualificado: pt.qualificado, faltam: pt.faltam });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /** As metas da semana, que o roteiro define e ninguém acompanhava. */
  app.get('/api/visitas/painel', (req, res) => {
    const d = tdb(req);
    try {
      const so = souVendedor(req) ? 'AND vendedorId = @eu' : '';
      const n = (sql) => d.prepare(`SELECT COUNT(*) n FROM roteiro_visitas
        WHERE criadoEm >= date('now', '-7 days') ${so} ${sql}`).get({ eu: meuId(req) }).n;
      const roteiro = d.prepare("SELECT config FROM roteiros WHERE canal = 'visita' ORDER BY padrao DESC, id LIMIT 1").get();
      const metas = roteiro ? (configDe(roteiro).metas || {}) : {};
      res.json({ success: true, metas, semana: {
        visitas: n(''),
        videos: n('AND videoAssistido = 1'),
        agendadas: n("AND status = 'agendado'"),
        contadores: n("AND TRIM(COALESCE(contador,'')) <> ''"),
      } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
}

module.exports = { registrarRotasRoteiros };
