/**
 * Agendamento de reunião pelo próprio lead.
 *
 * ── Quem entra sem sessão, e por quê ───────────────────────────────────────
 *
 * O lead que recebe o link no WhatsApp não tem conta aqui, e não deve ter. O
 * desenho é o mesmo do orçamento público (`/api/orcamento-publico/:token`), que
 * já roda nesta casa: token de 64 hex sorteado com `crypto.randomBytes(32)`,
 * formato conferido por regex ANTES de ir ao banco, e cada token serve a UM
 * convite. Não há listagem, não há busca, e o token não abre mais nada.
 *
 * O recorte do que o lead vê é deliberado: nome da empresa, duração e horários
 * livres. Não vai nome de vendedor, não vai agenda cheia, não vai dado de outro
 * contato — a lista de horários LIVRES não revela com quem são os ocupados.
 *
 * ── A corrida ──────────────────────────────────────────────────────────────
 *
 * Dois leads podem abrir a tela ao mesmo tempo e clicar no mesmo horário. A
 * confirmação roda dentro de uma transação e se apoia no índice único parcial
 * `idx_agenda_slot`: quem chegar depois leva erro do banco e recebe "esse
 * horário acabou de ser tomado", com a lista já recarregada. Sem isso, os dois
 * saem convencidos de que têm as 14h.
 */
const crypto = require('crypto');

const agenda = require('./agenda-reuniao');
const { enviarWhatsApp } = require('./whatsapp-adapter');

const TOKEN_RE = /^[a-f0-9]{64}$/;
const VALIDADE_DIAS = 14;

function registrarRotasAgenda(app, db) {
  const cfgDe = (tdb) => agenda.lerConfig((chave) => {
    try { return tdb.prepare('SELECT valor FROM config WHERE chave = ?').get(chave)?.valor || ''; }
    catch { return ''; }
  });

  /** Horários já comprometidos do responsável: agendados aqui e marcados à mão. */
  function ocupadosDe(tdb, responsavelId) {
    const fora = [];
    try {
      for (const r of tdb.prepare(
        "SELECT dataHora FROM agenda_reunioes WHERE responsavelId = ? AND estado = 'marcada'")
        .all(responsavelId)) fora.push(r.dataHora);
    } catch { /* tenant ainda sem a tabela */ }
    try {
      // A agenda que a equipe já usa vale como ocupação: o vendedor que marcou
      // uma visita às 14h não pode receber uma reunião em cima.
      for (const r of tdb.prepare(
        'SELECT dataHora FROM crm_atividades WHERE usuarioId = ? AND concluida = 0')
        .all(responsavelId)) fora.push(String(r.dataHora || '').slice(0, 16));
    } catch { /* tenant sem CRM */ }
    return fora;
  }

  function horariosDe(tdb, responsavelId, agora) {
    const cfg = cfgDe(tdb);
    if (!cfg.ativo || !cfg.faixas) return { cfg, horarios: [] };
    return { cfg, horarios: agenda.proximosHorarios({
      faixas: cfg.faixas, duracaoMin: cfg.duracaoMin, antecedenciaMin: cfg.antecedenciaMin,
      janelaDias: cfg.janelaDias, maxSlots: cfg.maxSlots,
      ocupados: ocupadosDe(tdb, responsavelId), agora }) };
  }

  const empresaDe = (tdb) => {
    try { return tdb.prepare('SELECT razaoSocial, nomeFantasia FROM fornecedor ORDER BY id DESC LIMIT 1').get(); }
    catch { return null; }
  };

  // ==================== interno (exige sessão) ====================

  /**
   * Gera o convite de uma conversa e devolve o link.
   *
   * A agenda é a do DONO da conversa. Conversa sem dono é recusada aqui, e não
   * remendada com um responsável qualquer: marcar reunião na agenda de alguém
   * que não assumiu o atendimento é pior do que não marcar.
   */
  app.post('/api/conversas/:id/convite-agenda', (req, res) => {
    const tdb = req.tenantDb || db;
    try {
      const conversa = tdb.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(req.params.id);
      if (!conversa) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
      if (!conversa.donoId) {
        return res.status(400).json({ success: false, semDono: true,
          error: 'Assuma a conversa antes de agendar — a reunião entra na agenda de quem atende' });
      }
      const cfg = cfgDe(tdb);
      if (!cfg.ativo || !cfg.faixas) {
        return res.status(400).json({ success: false,
          error: 'Agendamento desligado. Configure os horários em IA e campanhas, aba Canal.' });
      }

      // Convite aberto da mesma conversa é reaproveitado: dois links vivos para
      // o mesmo contato fariam o lead marcar duas reuniões.
      const aberto = tdb.prepare(`SELECT * FROM agenda_reunioes
        WHERE conversaId = ? AND estado = 'convidado' AND expiraEm > datetime('now')`).get(conversa.id);
      let token = aberto?.token;
      if (!token) {
        token = crypto.randomBytes(32).toString('hex');
        tdb.prepare(`INSERT INTO agenda_reunioes
            (token, conversaId, pessoaId, responsavelId, nomeContato, telefone, expiraEm)
          VALUES (?,?,?,?,?,?, datetime('now', '+${VALIDADE_DIAS} days'))`)
          .run(token, conversa.id, conversa.pessoaId || null, conversa.donoId,
               conversa.nome || null, conversa.telefone || null);
      }
      res.json({ success: true, token, url: `/agendar.html?token=${token}` });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  /** Configuração da agenda, para a aba Canal. */
  app.get('/api/agenda/config', (req, res) => {
    const tdb = req.tenantDb || db;
    try { res.json({ success: true, config: cfgDe(tdb) }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/agenda/config', (req, res) => {
    const tdb = req.tenantDb || db;
    try {
      const b = req.body || {};
      const up = tdb.prepare(
        "INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)");
      // As faixas são VALIDADAS aqui, e não só na tela. Hora inválida gravada
      // faria o cálculo pular o dia calado, e a agenda apareceria vazia sem que
      // nada dissesse por quê.
      if (b.faixas && typeof b.faixas === 'object') {
        const { DIAS, minutos } = require('./atendimento-horario');
        const limpas = {};
        for (const d of DIAS) {
          const f = b.faixas[d];
          if (!Array.isArray(f)) { limpas[d] = null; continue; }
          const de = minutos(f[0]), ate = minutos(f[1]);
          if (de === null || ate === null) {
            return res.status(400).json({ success: false,
              error: `Horário inválido em ${d}: use HH:MM (veio "${f[0]}" e "${f[1]}")` });
          }
          if (ate <= de) {
            return res.status(400).json({ success: false,
              error: `Em ${d}, o fim precisa ser depois do início — para fechar o dia, desmarque-o` });
          }
          limpas[d] = [f[0], f[1]];
        }
        up.run('agenda_faixas', JSON.stringify(limpas));
      }
      if (b.ativo !== undefined) up.run('agenda_ativo', b.ativo ? '1' : '0');
      for (const [campo, chave] of [['duracaoMin', 'agenda_duracao_min'],
                                    ['antecedenciaMin', 'agenda_antecedencia_min'],
                                    ['janelaDias', 'agenda_janela_dias']]) {
        const v = Number(b[campo]);
        if (Number.isFinite(v) && v > 0) up.run(chave, String(Math.round(v)));
      }
      res.json({ success: true, config: cfgDe(tdb) });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // ==================== público (só o token) ====================

  function convitePorToken(tdb, token) {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    return tdb.prepare('SELECT * FROM agenda_reunioes WHERE token = ?').get(token) || null;
  }

  app.get('/api/agendar/:token', (req, res) => {
    const tdb = req.tenantDb || db;
    try {
      const c = convitePorToken(tdb, req.params.token);
      if (!c) return res.status(404).json({ success: false, error: 'Convite não encontrado' });
      if (c.estado === 'convidado' && c.expiraEm && c.expiraEm < new Date().toISOString().slice(0, 19).replace('T', ' ')) {
        return res.status(410).json({ success: false, error: 'Este convite expirou. Peça um novo ao atendimento.' });
      }
      const empresa = empresaDe(tdb);
      const base = { success: true, estado: c.estado, nome: c.nomeContato || null,
                     empresa: empresa?.nomeFantasia || empresa?.razaoSocial || null };
      if (c.estado === 'marcada') {
        return res.json({ ...base, dataHora: c.dataHora, porExtenso: agenda.porExtenso(c.dataHora) });
      }
      const { cfg, horarios } = horariosDe(tdb, c.responsavelId, new Date());
      res.json({ ...base, duracaoMin: cfg.duracaoMin, horarios,
                 porExtenso: horarios.map(agenda.porExtenso) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/agendar/:token', (req, res) => {
    const tdb = req.tenantDb || db;
    try {
      const c = convitePorToken(tdb, req.params.token);
      if (!c) return res.status(404).json({ success: false, error: 'Convite não encontrado' });
      if (c.estado === 'marcada') {
        return res.status(409).json({ success: false, jaMarcada: true,
          error: 'Este convite já tem reunião marcada.' });
      }
      const escolhido = String(req.body?.dataHora || '');

      // O horário é reconferido contra a lista do servidor. Confiar no que a
      // tela mandou deixaria marcar fora do expediente com uma requisição à mão.
      const { cfg, horarios } = horariosDe(tdb, c.responsavelId, new Date());
      if (!horarios.includes(escolhido)) {
        return res.status(409).json({ success: false, horarios,
          porExtenso: horarios.map(agenda.porExtenso),
          error: 'Esse horário não está mais livre. Escolha outro, por favor.' });
      }

      const nome = String(req.body?.nome || c.nomeContato || '').trim().slice(0, 120);
      const email = String(req.body?.email || '').trim().slice(0, 150);

      let atividadeId = null;
      const gravar = tdb.transaction(() => {
        // O UPDATE vem primeiro de propósito: é ele que bate no índice único
        // parcial e derruba o segundo lead antes de qualquer outro efeito.
        const r = tdb.prepare(`UPDATE agenda_reunioes
            SET estado = 'marcada', dataHora = ?, nomeContato = ?, email = ?,
                marcadoEm = datetime('now')
          WHERE id = ? AND estado <> 'marcada'`).run(escolhido, nome || null, email || null, c.id);
        if (!r.changes) throw new Error('convite já usado');

        try {
          atividadeId = tdb.prepare(`INSERT INTO crm_atividades
              (clienteId, tipo, titulo, descricao, dataHora, usuarioId)
            VALUES (?, 'reuniao', ?, ?, ?, ?)`)
            .run(c.pessoaId || null, `Reunião com ${nome || 'contato do WhatsApp'}`,
                 `Agendada pelo próprio contato${c.telefone ? ' (' + c.telefone + ')' : ''}.`,
                 escolhido, c.responsavelId).lastInsertRowid;
          tdb.prepare('UPDATE agenda_reunioes SET atividadeId = ? WHERE id = ?').run(atividadeId, c.id);
        } catch (_) { /* tenant sem CRM: a reunião vale, só não entra no funil */ }
      });

      try { gravar(); }
      catch (err) {
        // UNIQUE do índice parcial: outro lead levou este horário há instantes.
        const de = horariosDe(tdb, c.responsavelId, new Date());
        return res.status(409).json({ success: false, horarios: de.horarios,
          porExtenso: de.horarios.map(agenda.porExtenso),
          error: 'Esse horário acabou de ser reservado por outra pessoa. Escolha outro, por favor.' });
      }

      avisar(tdb, c, escolhido, cfg.duracaoMin);
      res.json({ success: true, dataHora: escolhido, porExtenso: agenda.porExtenso(escolhido),
                 ics: `/api/agendar/${c.token}/ics` });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/agendar/:token/cancelar', (req, res) => {
    const tdb = req.tenantDb || db;
    try {
      const c = convitePorToken(tdb, req.params.token);
      if (!c) return res.status(404).json({ success: false, error: 'Convite não encontrado' });
      if (c.estado !== 'marcada') return res.status(409).json({ success: false, error: 'Não há reunião marcada' });
      tdb.prepare(`UPDATE agenda_reunioes SET estado = 'cancelada', canceladoEm = datetime('now')
        WHERE id = ?`).run(c.id);
      if (c.atividadeId) {
        try {
          tdb.prepare(`UPDATE crm_atividades SET titulo = 'CANCELADA: ' || titulo, concluida = 1,
            dataConclusao = datetime('now') WHERE id = ?`).run(c.atividadeId);
        } catch (_) { }
      }
      avisarCancelamento(tdb, c);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  /** O convite em .ics. Aberto pelo token, como o resto. */
  app.get('/api/agendar/:token/ics', (req, res) => {
    const tdb = req.tenantDb || db;
    try {
      const c = convitePorToken(tdb, req.params.token);
      if (!c || !c.dataHora) return res.status(404).send('Convite não encontrado');
      const cfg = cfgDe(tdb);
      const empresa = empresaDe(tdb);
      const nome = empresa?.nomeFantasia || empresa?.razaoSocial || 'Reunião';
      const ics = agenda.gerarIcs({
        uid: `agenda-${c.id}-${c.token.slice(0, 12)}@liciteagora`,
        inicio: c.dataHora, duracaoMin: cfg.duracaoMin,
        titulo: `Reunião com ${nome}`, organizador: nome,
        cancelado: c.estado === 'cancelada',
      });
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="reuniao.ics"');
      res.send(ics);
    } catch (e) { res.status(500).send(e.message); }
  });

  // ==================== avisos ====================

  /**
   * Confirma para o lead e avisa quem vai atender.
   *
   * O `.ics` vai como LINK, e não como anexo: o envio de mídia do adapter é
   * fixo em imagem, e o link abre o calendário do celular do mesmo jeito. Quem
   * tiver e-mail recebe o arquivo de verdade, anexado.
   */
  function avisar(tdb, convite, quando, duracaoMin) {
    const quandoTxt = agenda.porExtenso(quando);
    const link = `/api/agendar/${convite.token}/ics`;
    if (convite.telefone) {
      // `.catch` e não try/catch: estas duas são `async`, e o que elas lançam
      // vira rejeição de promessa. Um try/catch não pega isso, e a rejeição sem
      // dono DERRUBA o processo — o canal de WhatsApp fora do ar levaria o
      // servidor inteiro junto, depois de a reunião já estar gravada.
      Promise.resolve()
        .then(() => enviarWhatsApp(tdb, { telefone: convite.telefone,
          texto: `Reunião confirmada para ${quandoTxt} (${duracaoMin} min).\n\n`
            + `Para salvar no seu calendário: ${link}\n\n`
            + 'Se precisar cancelar, é só responder por aqui.' }))
        .catch((e) => console.error('[Agenda] confirmação não saiu:', e.message));
    }
    Promise.resolve()
      .then(() => require('./notificacoes-dispatcher').enviarAlerta(tdb, {
        subject: 'Reunião agendada',
        body: `${convite.nomeContato || convite.telefone || 'Um contato'} marcou ${quandoTxt}.`,
        logTag: 'Agenda',
      }))
      .catch((e) => console.error('[Agenda] aviso interno não saiu:', e.message));
  }

  function avisarCancelamento(tdb, convite) {
    Promise.resolve()
      .then(() => require('./notificacoes-dispatcher').enviarAlerta(tdb, {
        subject: 'Reunião cancelada',
        body: `${convite.nomeContato || convite.telefone || 'Um contato'} cancelou `
          + `${agenda.porExtenso(convite.dataHora)}.`,
        logTag: 'Agenda',
      }))
      .catch((e) => console.error('[Agenda] aviso de cancelamento não saiu:', e.message));
  }
}

module.exports = { registrarRotasAgenda };
