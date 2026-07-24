// portais-integracao-routes.js
//
// CRUD genérico de credenciais de portais externos (usuário + senha)
// que ainda não têm pipeline própria (Comprasnet e SC têm). Registry
// abaixo lista os portais; adicionar novo é 1 linha.
//
// Cada portal grava em duas chaves da tabela `config` do tenant:
//   <key>_usuario  e  <key>_senha
//
// Rotas:
//   GET    /api/integracoes/portais                  → lista todos com status
//   POST   /api/integracoes/portais/:key/credenciais → upsert {usuario, senha}
//   DELETE /api/integracoes/portais/:key/credenciais → remove ambas as chaves
//
// GET nunca devolve a senha — só o usuário e flag `configurado`.
// Senhas em texto puro (mesmo padrão de comprasnet/sc; criptografia é
// onda de segurança separada).

const PORTAIS = [
  {
    key: 'bnc',
    label: 'BNC Compras',
    descricao: 'Bolsa Nacional de Compras — email e senha de 6 dígitos (login real é feito pelo app LiciteAgora BNC; este formulário só persiste a credencial)',
    site: 'https://bnccompras.com',
    rotuloUsuario: 'Email',
    rotuloSenha: 'Senha (6 dígitos)',
    probe: true, // verifica se o app electron-bnc capturou a sessão (não loga aqui)
  },
  {
    key: 'bll',
    label: 'BLL Compras',
    descricao: 'Bolsa de Licitações e Leilões — usuário e senha de fornecedor',
    site: 'https://bll.org.br',
    rotuloUsuario: 'Usuário',
    rotuloSenha: 'Senha',
  },
  {
    key: 'pcp',
    label: 'Portal de Compras Públicas',
    descricao: 'Portal de Compras Públicas (Governança Brasil) — usuário e senha de fornecedor',
    site: 'https://www.portaldecompraspublicas.com.br',
    rotuloUsuario: 'Usuário',
    rotuloSenha: 'Senha',
    probe: true, // habilita botão "Testar conexão" → POST /api/integracoes/portais/pcp/probe
  },
];

function getPortal(key) {
  return PORTAIS.find((p) => p.key === key) || null;
}

function chaves(key) {
  return { usuario: `${key}_usuario`, senha: `${key}_senha` };
}

function registrarRotasPortaisIntegracao(app, db) {
  // Lista todos os portais com status de configuração
  app.get('/api/integracoes/portais', (req, res) => {
    try {
      const stmt = db.prepare('SELECT chave, valor, dataAtualizacao FROM config WHERE chave = ?');
      const portais = PORTAIS.map((p) => {
        const c = chaves(p.key);
        const u = stmt.get(c.usuario);
        const s = stmt.get(c.senha);
        return {
          key: p.key,
          label: p.label,
          descricao: p.descricao,
          site: p.site,
          rotuloUsuario: p.rotuloUsuario,
          rotuloSenha: p.rotuloSenha,
          configurado: !!(u && u.valor && s && s.valor),
          usuario: u?.valor || null,
          atualizadoEm: u?.dataAtualizacao || s?.dataAtualizacao || null,
          probe: !!p.probe,
        };
      });
      res.json({ success: true, portais });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Salvar credenciais (upsert)
  app.post('/api/integracoes/portais/:key/credenciais', (req, res) => {
    try {
      const portal = getPortal(req.params.key);
      if (!portal) return res.status(404).json({ success: false, error: 'Portal desconhecido' });

      const { usuario, senha } = req.body || {};
      if (!usuario || !senha) {
        return res.status(400).json({ success: false, error: 'Usuário e senha são obrigatórios' });
      }

      const c = chaves(portal.key);
      const upsert = db.prepare(
        'INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)'
      );
      upsert.run(c.usuario, String(usuario).trim());
      upsert.run(c.senha, String(senha));

      res.json({ success: true, message: `Credenciais ${portal.label} salvas` });
    } catch (e) {
      console.error('[Integrações] erro ao salvar:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Probe de login (apenas portais com probe:true no registry)
  app.post('/api/integracoes/portais/:key/probe', async (req, res) => {
    try {
      const portal = getPortal(req.params.key);
      if (!portal) return res.status(404).json({ success: false, error: 'Portal desconhecido' });
      if (!portal.probe) return res.status(400).json({ success: false, error: `Probe não implementado para ${portal.label}` });

      const c = chaves(portal.key);
      const u = db.prepare('SELECT valor FROM config WHERE chave = ?').get(c.usuario);
      const s = db.prepare('SELECT valor FROM config WHERE chave = ?').get(c.senha);
      if (!u?.valor || !s?.valor) {
        return res.status(400).json({ success: false, error: 'Credenciais não configuradas' });
      }

      let result;
      if (portal.key === 'pcp') {
        const { probePcpLogin } = require('./pcp-auth');
        result = await probePcpLogin(u.valor, s.valor);
      } else if (portal.key === 'bnc') {
        // BNC não loga server-side (teclado virtual + captcha + ProcessUserSession).
        // O login real é responsabilidade do app electron-bnc. Aqui só verificamos
        // se ele já capturou a sessão e se está fresca o suficiente pra usar.
        const { getSessionInfo, bncGet, BncSessaoExpiradaError, BncSessaoIndisponivelError } = require('./bnc-client');
        const info = getSessionInfo(db);
        if (!info.configurado) {
          result = {
            ok: false,
            etapa: 'sem-sessao',
            error: 'O app LiciteAgora BNC ainda não enviou os cookies de sessão. Abra o app e faça login.',
            info,
          };
        } else {
          // Testa a sessão com uma chamada inócua (GetTimeNow é XHR autenticado leve)
          try {
            const r = await bncGet(db, '/Home/GetTimeNow');
            result = {
              ok: true,
              status: r.status,
              etapa: 'sessao-ok',
              info,
              amostra: (r.body || '').slice(0, 60),
            };
          } catch (e) {
            if (e instanceof BncSessaoExpiradaError) {
              result = { ok: false, etapa: 'sessao-expirada', error: e.message, info };
            } else if (e instanceof BncSessaoIndisponivelError) {
              result = { ok: false, etapa: 'sem-sessao', error: e.message, info };
            } else {
              result = { ok: false, etapa: 'erro-rede', error: e.message, info };
            }
          }
        }
      } else {
        return res.status(500).json({ success: false, error: 'Probe sem implementação registrada' });
      }

      res.json({ success: true, result });
    } catch (e) {
      console.error(`[Integrações] probe ${req.params.key} erro:`, e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Remover credenciais
  app.delete('/api/integracoes/portais/:key/credenciais', (req, res) => {
    try {
      const portal = getPortal(req.params.key);
      if (!portal) return res.status(404).json({ success: false, error: 'Portal desconhecido' });

      const c = chaves(portal.key);
      db.prepare('DELETE FROM config WHERE chave IN (?, ?)').run(c.usuario, c.senha);

      res.json({ success: true, message: `Credenciais ${portal.label} removidas` });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  console.log('[Integrações] Rotas registradas (portais:', PORTAIS.map((p) => p.key).join(', ') + ')');
}

module.exports = { registrarRotasPortaisIntegracao, PORTAIS };
