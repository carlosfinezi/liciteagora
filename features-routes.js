/**
 * features-routes.js
 *
 * Endpoint genérico que devolve o estado de TODAS as feature flags do
 * tenant em uma única chamada. Usado pelo sidebar pra decidir o que
 * mostrar no menu lateral.
 *
 * Origem da verdade da flag: tabela `config` do tenant, chave
 * `<feature>_enabled` ('1' = ativa, qualquer outra coisa = inativa).
 * Quem altera é o super-admin via PATCH /api/admin/tenants/:slug/features
 * (control-plane-routes.js). Aqui é read-only.
 *
 * O catálogo canônico vive em control-plane-routes.js (FEATURES).
 * Replicamos só as chaves aqui para evitar acoplar o tenant à camada
 * de control-plane.
 */

const FEATURE_KEYS = ['optica', 'licitacoes', 'operacional', 'habilitacao', 'comercial', 'os', 'produtos', 'comunicacao', 'whatsapp', 'rh', 'varejo', 'fiscal', 'financeiro', 'classificacao_fiscal'];

function lerFeatures(db) {
  const out = {};
  for (const key of FEATURE_KEYS) {
    try {
      const row = db.prepare('SELECT valor FROM config WHERE chave = ?').get(key + '_enabled');
      out[key] = !!(row && row.valor === '1');
    } catch {
      out[key] = false;
    }
  }
  return out;
}

function registrarRotasFeatures(app, db) {
  app.get('/api/features/status', (req, res) => {
    res.json({ success: true, features: lerFeatures(db) });
  });
}

module.exports = { registrarRotasFeatures, FEATURE_KEYS, lerFeatures };
