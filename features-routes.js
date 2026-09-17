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

const FEATURE_KEYS = ['optica', 'restaurante', 'farmacia', 'posto', 'locacao', 'producao', 'licitacoes', 'operacional', 'habilitacao', 'comercial', 'os', 'produtos', 'comunicacao', 'whatsapp', 'rh', 'patrimonio', 'varejo', 'fiscal', 'financeiro', 'contabilidade', 'cobranca', 'classificacao_fiscal', 'ssl'];

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

// Modo do menu lateral, padrão do tenant. Mesma tabela `config` das flags.
// 'unico'   = todas as seções numa lista rolável (comportamento histórico)
// 'modulos' = uma seção por vez, com seletor de módulos
// O usuário pode sobrescrever em users.menuModo (/api/user/prefs).
const MENU_MODOS = ['unico', 'modulos'];

function lerMenuModo(db) {
  try {
    const row = db.prepare('SELECT valor FROM config WHERE chave = ?').get('menu_modo');
    return MENU_MODOS.includes(row && row.valor) ? row.valor : 'unico';
  } catch {
    return 'unico';
  }
}

function registrarRotasFeatures(app, db) {
  // A sidebar chama isto em toda página; o modo do tenant vai junto para não
  // custar uma segunda requisição no boot.
  app.get('/api/features/status', (req, res) => {
    res.json({ success: true, features: lerFeatures(db), menuModo: lerMenuModo(db) });
  });

  // Grava o padrão do tenant. /api/features está em LIBERADOS (perfis-api-map),
  // então quem barra usuário comum aqui é este check de role, não o RBAC de página.
  app.post('/api/features/menu-modo', (req, res) => {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'apenas administrador' });
    }
    const { modo } = req.body || {};
    if (!MENU_MODOS.includes(modo)) {
      return res.status(400).json({ success: false, error: 'modo inválido' });
    }
    db.prepare('INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)')
      .run('menu_modo', modo);
    res.json({ success: true, menuModo: modo });
  });
}

module.exports = { registrarRotasFeatures, FEATURE_KEYS, lerFeatures, lerMenuModo, MENU_MODOS };
