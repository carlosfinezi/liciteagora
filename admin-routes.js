// admin-routes.js
//
// Rotas administrativas/meta do servidor — não pertencem a nenhum
// subdomínio de negócio. Extraído de server.js em NFSE-M06 onda 6.18.
//
// Escopo: 3 rotas:
//   GET  /api/debug/tabela/:nome   PRAGMA table_info(:nome), útil
//                                   para diagnóstico rápido de schema
//                                   sem precisar abrir o sqlite3 CLI.
//                                   Só expõe metadados (colunas/tipos),
//                                   não retorna dados da tabela.
//   GET  /api/config/server-url    devolve a URL configurada do
//                                   servidor (fallback: auto-detecta
//                                   via req.protocol + req.get('host')).
//                                   Inclui flag "configurada" e a
//                                   "detectada" em paralelo, útil
//                                   para o front saber se o admin já
//                                   fixou a URL ou está no fallback.
//   POST /api/config/server-url    grava server_url na config; remove
//                                   trailing slash antes de salvar.
//
// DEPENDÊNCIAS do módulo:
//   - db                        better-sqlite3 (para /api/debug/tabela)
//   - opts.getConfigValue(k)    helper para ler config (chave → valor)
//   - opts.setConfigValue(k,v)  helper para escrever config
//
// Os dois helpers de config vêm do server.js (funções internas) e já
// são passados para outros módulos (ex.: analise-ia-routes).
//
// SEGURANÇA: /api/debug/tabela/:nome aceita qualquer nome de tabela
// via params — é uma rota administrativa *autenticada* (está atrás
// da barreira de auth do server.js). Não há risco de SQL injection
// porque PRAGMA table_info não aceita valores arbitrários — nomes
// inválidos retornam array vazio em vez de executar SQL. Comportamento
// preservado 1:1 do monolito.

function registrarRotasAdmin(app, db, { getConfigValue, setConfigValue }) {
  if (!getConfigValue || !setConfigValue) {
    throw new Error('admin-routes: getConfigValue e setConfigValue são obrigatórios');
  }

  // Rota de debug para verificar estrutura da tabela
  app.get('/api/debug/tabela/:nome', (req, res) => {
    try {
      const info = db.pragma(`table_info(${req.params.nome})`);
      res.json({ success: true, columns: info });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Retorna a URL do servidor configurada (com fallback para auto-detecção)
  app.get('/api/config/server-url', (req, res) => {
    try {
      const urlConfigurada = getConfigValue('server_url');
      const urlDetectada = req.protocol + '://' + req.get('host');
      res.json({
        success: true,
        url: urlConfigurada || urlDetectada,
        configurada: !!urlConfigurada,
        detectada: urlDetectada
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Salva a URL do servidor
  app.post('/api/config/server-url', (req, res) => {
    try {
      let { url } = req.body;
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, error: 'URL é obrigatória' });
      }
      // Remove trailing slash
      url = url.replace(/\/+$/, '');
      setConfigValue('server_url', url);
      res.json({ success: true, url });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Admin] Rotas registradas');
}

module.exports = { registrarRotasAdmin };
