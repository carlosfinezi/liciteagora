// proxy-routes.js
//
// Rotas HTTP para Configuração de Proxy (servidor, porta, usuário, senha,
// ativo). Extraído de server.js em NFSE-M06 onda 6.8.
//
// O bloco é um CRUD de 3 rotas (POST/GET/DELETE /api/proxy) que persiste
// em 5 chaves da tabela `config` (proxy_servidor, proxy_porta,
// proxy_usuario, proxy_senha, proxy_ativo). GET não devolve a senha — só
// servidor/porta/usuário/ativo. DELETE faz `DELETE FROM config WHERE
// chave LIKE 'proxy_%'` (derruba todas as chaves de uma vez).
//
// IMPORTANTE: senha é salva em texto puro em `config.valor`. Manter 1:1
// com o monolito original. Proteção de credenciais de proxy é uma onda
// de segurança separada — não é escopo aqui.

function registrarRotasProxy(app, db) {
  // Salvar configuração de proxy
  app.post('/api/proxy', (req, res) => {
    try {
      const { servidor, porta, usuario, senha, ativo } = req.body;

      if (ativo && (!servidor || !porta)) {
        return res.status(400).json({ success: false, error: 'Servidor e porta são obrigatórios quando o proxy está ativo' });
      }

      // Salvar configurações
      db.prepare(`INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES ('proxy_servidor', ?, CURRENT_TIMESTAMP)`).run(servidor || '');
      db.prepare(`INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES ('proxy_porta', ?, CURRENT_TIMESTAMP)`).run(porta || '');
      db.prepare(`INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES ('proxy_usuario', ?, CURRENT_TIMESTAMP)`).run(usuario || '');
      db.prepare(`INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES ('proxy_senha', ?, CURRENT_TIMESTAMP)`).run(senha || '');
      db.prepare(`INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES ('proxy_ativo', ?, CURRENT_TIMESTAMP)`).run(ativo ? '1' : '0');

      res.json({ success: true, message: 'Configuração de proxy salva' });
    } catch (error) {
      console.error('Erro ao salvar proxy:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Verificar configuração de proxy
  app.get('/api/proxy', (req, res) => {
    try {
      const servidor = db.prepare(`SELECT valor FROM config WHERE chave = 'proxy_servidor'`).get();
      const porta = db.prepare(`SELECT valor FROM config WHERE chave = 'proxy_porta'`).get();
      const usuario = db.prepare(`SELECT valor FROM config WHERE chave = 'proxy_usuario'`).get();
      const ativo = db.prepare(`SELECT valor FROM config WHERE chave = 'proxy_ativo'`).get();

      res.json({
        success: true,
        data: {
          servidor: servidor?.valor || '',
          porta: porta?.valor || '',
          usuario: usuario?.valor || '',
          ativo: ativo?.valor === '1'
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Remover configuração de proxy
  app.delete('/api/proxy', (req, res) => {
    try {
      db.prepare(`DELETE FROM config WHERE chave LIKE 'proxy_%'`).run();
      res.json({ success: true, message: 'Configuração de proxy removida' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Proxy] Rotas registradas');
}

module.exports = { registrarRotasProxy };
