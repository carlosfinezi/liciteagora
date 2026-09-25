/**
 * push-routes.js — inscrição do aparelho e o que o service worker vai buscar.
 *
 * ── O caminho inteiro, em uma passada ──────────────────────────────────────
 *
 *   1. a pessoa liga o pop-up em Comunicação → IA e Campanhas;
 *   2. o navegador pede permissão e devolve um ENDPOINT (uma URL do servidor de
 *      push da Google ou da Mozilla, única por aparelho);
 *   3. esse endpoint é gravado aqui, amarrado ao usuário logado;
 *   4. chegou mensagem de lead no WhatsApp → o webhook manda um sinal VAZIO
 *      para cada endpoint do tenant;
 *   5. o service worker acorda, chama `/api/push/pendentes` com a sessão da
 *      própria pessoa e monta o pop-up com nome e trecho.
 *
 * O passo 5 é o que mantém o conteúdo da conversa fora do servidor de push. Ver
 * o cabeçalho de `push-web.js`.
 */
const { lerOuCriarChaves, enviarSinal } = require('./push-web');

const CONTATO = 'mailto:suporte@liciteagora.com.br';

/** Chaves VAPID do tenant, criadas na primeira necessidade (ver `push-web.js`). */
const chaves = (db) => lerOuCriarChaves(db);

/**
 * Avisa os aparelhos inscritos deste tenant.
 *
 * Chamado de dentro do webhook, depois de a mensagem do lead estar gravada.
 * Nunca lança: um push que falha não pode derrubar o recebimento da mensagem,
 * que é a parte que não se recupera.
 */
async function avisarInscritos(db, { excetoUsuarioId = null } = {}) {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='push_inscricoes'").get()) return 0;
    const ligado = db.prepare("SELECT valor FROM config WHERE chave = 'whatsapp_popup_ativo'").get();
    if (ligado?.valor !== '1') return 0;              // a empresa não ligou: silêncio

    const linhas = db.prepare('SELECT * FROM push_inscricoes' +
      (excetoUsuarioId ? ' WHERE usuarioId <> ?' : '')).all(...(excetoUsuarioId ? [excetoUsuarioId] : []));
    let enviados = 0;
    for (const i of linhas) {
      let r;
      try { r = await enviarSinal(i, chaves(db), CONTATO); }
      catch (e) { r = { ok: false, morta: false, status: 0, erro: e.message }; }

      if (r.ok) {
        enviados++;
        db.prepare("UPDATE push_inscricoes SET ultimoEnvio = CURRENT_TIMESTAMP, falhas = 0 WHERE id = ?").run(i.id);
      } else if (r.morta) {
        // 404/410: o navegador diz que esta inscrição não existe mais. Insistir
        // é gastar requisição para sempre, então ela sai.
        db.prepare('DELETE FROM push_inscricoes WHERE id = ?').run(i.id);
      } else {
        db.prepare('UPDATE push_inscricoes SET falhas = falhas + 1 WHERE id = ?').run(i.id);
      }
    }
    return enviados;
  } catch (e) {
    console.error('[push] falha ao avisar inscritos:', e.message);
    return 0;
  }
}

function registrarRotasPush(app, db) {
  /** A chave pública que o navegador precisa para se inscrever. */
  app.get('/api/push/chave', (_req, res) => {
    try { res.json({ success: true, chave: chaves(db).publica }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  /** Liga este aparelho. Reinscrever o mesmo endpoint apenas atualiza o dono. */
  app.post('/api/push/inscrever', (req, res) => {
    try {
      const endpoint = String(req.body?.endpoint || '').trim();
      if (!/^https:\/\//.test(endpoint)) {
        return res.status(400).json({ success: false, error: 'Endpoint inválido' });
      }
      const usuarioId = Number(req.user?.id) || null;
      if (!usuarioId) return res.status(401).json({ success: false, error: 'Sem usuário na sessão' });

      db.prepare(`INSERT INTO push_inscricoes (usuarioId, endpoint, aparelho) VALUES (?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET usuarioId = excluded.usuarioId,
          aparelho = excluded.aparelho, falhas = 0`)
        .run(usuarioId, endpoint, String(req.body?.aparelho || '').slice(0, 120) || null);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /** Desliga este aparelho. */
  app.post('/api/push/desinscrever', (req, res) => {
    try {
      const endpoint = String(req.body?.endpoint || '').trim();
      if (endpoint) db.prepare('DELETE FROM push_inscricoes WHERE endpoint = ?').run(endpoint);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * O que o service worker mostra.
   *
   * Devolve as conversas com mensagem do LEAD nos últimos 10 minutos — a mesma
   * janela do TTL do push. Sem a janela, um push atrasado mostraria a conversa
   * de ontem como se fosse nova.
   *
   * Só mensagem recebida (`from_me = 0`): a resposta que a própria IA acabou de
   * mandar não é motivo para acordar ninguém.
   */
  app.get('/api/push/pendentes', (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ success: false, error: 'Sem sessão' });
      const desde = Math.floor(Date.now() / 1000) - 600;
      const linhas = db.prepare(`
        SELECT c.id, COALESCE(NULLIF(p.razaoSocial, ''), c.nome, c.telefone) AS quem,
               m.texto, m.timestamp
          FROM whatsapp_messages m
          JOIN conv_conversas c ON c.jid = m.remote_jid AND c.canal = 'whatsapp'
          LEFT JOIN pessoas p ON p.id = c.pessoaId
         WHERE m.from_me = 0 AND m.timestamp >= ?
         ORDER BY m.timestamp DESC LIMIT 5`).all(desde);
      res.json({
        success: true,
        itens: linhas.map(l => ({
          conversaId: l.id,
          quem: l.quem || 'Contato',
          // O trecho é cortado aqui, e não na tela: o que não sai do servidor não
          // precisa ser escondido depois.
          trecho: String(l.texto || '').replace(/\s+/g, ' ').slice(0, 90),
        })),
      });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
}

module.exports = { registrarRotasPush, avisarInscritos };
