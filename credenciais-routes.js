// credenciais-routes.js
//
// Rotas HTTP das Credenciais do Comprasnet (usuário + senha do gov.br
// operacional usado pelo monitor/sniper para login). Extraído de
// server.js em NFSE-M06 onda 6.12.
//
// CRUD simples em 2 chaves da tabela `config`: comprasnet_usuario e
// comprasnet_senha. São 3 rotas:
//   POST   /api/credenciais         → salvar (UPSERT via INSERT OR REPLACE)
//   GET    /api/credenciais/status  → {configurado: bool, usuario: string|null}
//   DELETE /api/credenciais         → apaga ambas as chaves
//
// GET NÃO devolve a senha — só o usuário. Mantido 1:1.
//
// IMPORTANTE: senha é salva em texto puro. Este é o comportamento
// original do monolito; proteção de credenciais é escopo de uma onda
// de segurança separada (junto com proxy_senha, govbr_senha e demais
// segredos em `config`).
//
// As duas chaves continuam sendo LIDAS em outro ponto de server.js
// (bloco do monitor de chat, ~linha 5347) — só os handlers HTTP saem
// daqui. Os leitores diretos de `config` não são afetados pela
// extração.

function registrarRotasCredenciais(app, db) {
  // Salvar credenciais
  app.post('/api/credenciais', (req, res) => {
    try {
      const { usuario, senha } = req.body;

      if (!usuario || !senha) {
        return res.status(400).json({ success: false, error: 'Usuário e senha são obrigatórios' });
      }

      // Salvar na tabela config
      const stmtUser = db.prepare(`INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES ('comprasnet_usuario', ?, CURRENT_TIMESTAMP)`);
      const stmtPass = db.prepare(`INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES ('comprasnet_senha', ?, CURRENT_TIMESTAMP)`);

      stmtUser.run(usuario);
      stmtPass.run(senha); // Em produção, deveria criptografar

      res.json({ success: true, message: 'Credenciais salvas com sucesso' });
    } catch (error) {
      console.error('Erro ao salvar credenciais:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Verificar se há credenciais salvas
  app.get('/api/credenciais/status', (req, res) => {
    try {
      const usuario = db.prepare(`SELECT valor FROM config WHERE chave = 'comprasnet_usuario'`).get();
      const senha = db.prepare(`SELECT valor FROM config WHERE chave = 'comprasnet_senha'`).get();

      res.json({
        success: true,
        configurado: !!(usuario && senha),
        usuario: usuario?.valor || null
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Remover credenciais
  app.delete('/api/credenciais', (req, res) => {
    try {
      db.prepare(`DELETE FROM config WHERE chave IN ('comprasnet_usuario', 'comprasnet_senha')`).run();
      res.json({ success: true, message: 'Credenciais removidas' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Credenciais] Rotas registradas');
}

module.exports = { registrarRotasCredenciais };
