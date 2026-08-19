// auth-bootstrap.js
//
// NFSE-M06 onda 6.40 (2026-04-20): consolida autenticação inicial,
// session middleware, barreira requireAuth e static protegido.
//
// Multi-tenant (2026-04-22):
//   - session_secret vem do CONTROL DB (único global) para que o
//     Express valide cookies independente do tenant.
//   - sessions são gravadas no DB do TENANT atual via SqliteSessionStore
//     que usa stmt-cache lazy.
//   - api_key vira lookup-per-request no requireAuth (compat: quando
//     não há controlDb, o modo single-tenant legado continua válido).
//   - criarUsuarioInicial MOVEU para provisionamento via control-plane;
//     o boot do worker não toca no DB de tenants.
//   - Cookie de sessão é por subdomínio (sem `domain` explícito), para
//     isolar tenants: login em a.liciteagora.app NÃO sobrescreve a
//     sessão de b.liciteagora.app. Versão anterior usava
//     `.liciteagora.app` como domain compartilhado, que derrubava a
//     sessão do tenant A ao logar no tenant B (mesmo cookie SID no
//     browser, regerado pelo express-session).

const path = require('path');
const express = require('express');
const session = require('express-session');
const {
  createSessionStore,
  criarUsuarioInicial,
  getSessionSecret,
  getApiKey,
  requireAuth,
} = require('./auth');

// Modo multi-tenant: controlDb obrigatório (fonte do session_secret
// único global), db é o proxy do tenant atual. Session store grava
// sessions no DB do tenant resolvido por AsyncLocalStorage.
//
// Modo single-tenant (compat): controlDb = null → session_secret e
// api_key vêm do próprio db (comportamento antigo). Usado por
// scheduler.js e dev local.
function initAuthAndSession(app, db, { controlDb = null } = {}) {
  if (!controlDb) {
    // Compat single-tenant: cria schema de users/audit/sessions e
    // semeia admin/admin no db passado.
    criarUsuarioInicial(db);
  }

  const secretSource = controlDb || db;
  const sessionSecret = getSessionSecret(secretSource);

  // apiKey fixo só em compat single-tenant. Em multi-tenant passamos
  // null e o requireAuth resolve o api_key do tenant atual em runtime.
  const apiKey = controlDb ? null : getApiKey(db);

  const isProd = process.env.NODE_ENV === 'production';

  app.use(session({
    store: createSessionStore(session, db, controlDb),
    secret: sessionSecret,
    name: 'liciteagora.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      // Sem `domain`: cada subdomínio tenant tem seu próprio cookie,
      // evitando colisão de SID entre tenants no mesmo browser.
    },
  }));

  return { apiKey };
}

function installAuthBarrier(app, db, { apiKey }) {
  app.use(requireAuth(apiKey, db));
}

// Páginas que mudaram de módulo. Sem isto, link salvo, atalho do navegador e
// aba aberta batem em 404 depois da mudança — e o usuário não tem como saber
// que a tela existe em outro lugar.
const PAGINAS_MOVIDAS = {
  '/financeiro/plano-contas.html': '/contabilidade/plano-contas.html',
  '/financeiro/centros-custo.html': '/contabilidade/centros-custo.html',
  '/financeiro/faturas.html': '/fiscal/faturas.html',
  '/financeiro/fatura-detalhe.html': '/fiscal/fatura-detalhe.html',
  '/financeiro/cobrancas.html': '/cobranca/cobrancas.html',
  '/financeiro/cobrancas-config.html': '/cobranca/cobrancas-config.html',
  // NFS-e emitidas virou um filtro da lista unificada de notas.
  '/fiscal/nfse-emitidas.html': '/fiscal/notas-fiscais.html?tipo=nfse',
  // Parâmetros de emissão são do emitente: moraram na tela de cada documento
  // até virarem uma seção do cadastro da empresa.
  '/fiscal/nfe-config.html': '/fiscal/configuracao.html',
  '/fiscal/nfce-config.html': '/fiscal/configuracao.html',
  // "NF-e Recebidas" era o nome da lista; a tela é o manifestador do destinatário.
  '/fiscal/nfe-inbox.html': '/fiscal/manifestador.html',
  // Tipos de operação carregam natureza fiscal e CFOP: são cadastro do Fiscal.
  '/configuracoes/cadastro-tipos-operacao.html': '/fiscal/cadastro-tipos-operacao.html',
  // Patrimônio saiu de dentro de RH: imobilizado não é gestão de pessoas.
  '/rh/patrimonio.html': '/patrimonio/bens.html',
  // Chave de API, uploads e portais são operação de integração, não ajuste de
  // preferência — saíram de Configurações.
  '/configuracoes/conexoes.html': '/operacional/conexoes.html',
  '/configuracoes/integracoes.html': '/operacional/integracoes.html',
  // Jornal removido: a descoberta por IA cobre a mesma varredura com
  // qualificação. Quem tiver o endereço salvo cai onde a função vive hoje.
  '/configuracoes/jornal.html': '/operacional/analises-ia.html',
  // Versões mostrava commit e branch do deploy — informação de servidor, não
  // do negócio do cliente. O painel de saúde do sistema fica em Status.
  '/configuracoes/versoes.html': '/configuracoes/status.html',
  // Comunicação: cinco telas com três APIs rivais viraram a central de
  // Conversas. Redirecionadas as que a central cobre por inteiro — conexão,
  // inbox e simulador de IA. As de campanha (wa-campanhas, wa-agenda) seguem
  // acessíveis por URL: a central lista e cancela, mas ainda não cria nem
  // agenda disparo.
  '/comunicacao/comunicacao.html': '/comunicacao/conversas.html',
  '/comunicacao/whatsapp.html': '/comunicacao/conversas.html',
  '/comunicacao/wa-simular.html': '/comunicacao/conversas.html',
};

function installProtectedStatic(app, db) {
  app.use((req, res, next) => {
    const destino = PAGINAS_MOVIDAS[req.path];
    // 301: o endereço novo é definitivo, então o navegador atualiza o favorito.
    if (destino) return res.redirect(301, destino);
    next();
  });
  // RBAC de página e de API. Precisa vir depois do requireAuth (usa req.user),
  // antes do static (senão o .html é servido sem decisão nenhuma) e antes do
  // route-registry (senão a rota de API responde antes do gate). Quem tem perfil
  // sem cadastro passa direto — ver perfis-acesso.js.
  app.use(require('./perfis-acesso').criarGateAcesso(db));
  app.use(express.static(path.join(__dirname, 'public')));
}

module.exports = { initAuthAndSession, installAuthBarrier, installProtectedStatic };
