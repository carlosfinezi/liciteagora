'use strict';
/**
 * suporte-routes.js — as rotas de chamado do CLIENTE, dentro do ERP.
 *
 * ── A primeira rota de tenant que lê o control.db ───────────────────────────
 *
 * Até aqui, toda rota de tenant trabalhava sobre o `db` do próprio tenant (o
 * proxy resolvido por AsyncLocalStorage). Os chamados moram no control.db, que
 * é global, então esta é a primeira a precisar das duas pontas:
 *
 *   `db`        — o tenant, usado SÓ para resolver quem é o usuário e o que
 *                 ele pode ver (perfis_acesso). Nenhum chamado mora nele.
 *   `controlDb` — onde os chamados vivem.
 *
 * A instância vem pronta de `server.js`, pelo mesmo objeto `deps` que já
 * carrega `db`, `pncpSync` e companhia. **Não se abre conexão nova por
 * requisição**: o control.db é um arquivo SQLite único e abrir por request
 * criaria dezenas de conexões concorrentes ao mesmo WAL.
 *
 * Sem `controlDb` (o caso do scheduler, que roda single-tenant) as rotas
 * simplesmente não são registradas. É melhor a rota não existir do que existir
 * respondendo 500.
 *
 * ── De onde vem o tenant ────────────────────────────────────────────────────
 *
 * De `req.tenant`, posto pelo `tenant-middleware` a partir do HOST. Nunca do
 * corpo, da query ou de cabeçalho: `tenant_id` enviado pelo browser não
 * decide propriedade de nada, e por isso não é lido em lugar nenhum deste
 * arquivo. O `exigirTenantDaSessao` é o único caminho.
 *
 * ── 404 em vez de 403 ───────────────────────────────────────────────────────
 *
 * Chamado de outra empresa responde 404 com a mesma mensagem de um id que não
 * existe. Um 403 confirmaria que aquele número é de alguém, que é exatamente
 * o que a enumeração procura.
 */

const repo = require('./suporte-repo');
const { acessoDoUsuario } = require('./perfis-acesso');

/** Resposta única para "não existe" e "não é seu". A diferença não vaza. */
function naoEncontrado(res) {
  return res.status(404).json({ success: false, error: 'Chamado não encontrado' });
}

/**
 * O tenant da SESSÃO, nunca o do request.
 * @returns {number|null} id do tenant, ou null se a requisição não tem tenant
 */
function tenantDaSessao(req) {
  const id = Number(req.tenant && req.tenant.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Quem enxerga os chamados de TODA a empresa, e quem só vê os próprios.
 *
 * A fonte é `acessoDoUsuario`, do `perfis-acesso.js` — a mesma que o gate de
 * RBAC usa. Nenhum papel, flag ou tabela nova.
 *
 * ── Por que `motivo === 'admin'`, e não `irrestrito` ───────────────────────
 *
 * `irrestrito` é verdadeiro em três situações, e o `motivo` as separa:
 *
 *   'admin'       `user.role === 'admin'` — administrador de verdade
 *   'sistema'     sem usuário (X-Api-Key). Não chega aqui: `exigirContexto`
 *                 devolve 401 antes, porque suporte é de gente, não de robô
 *   'sem-perfil'  o `role` do usuário não tem cadastro ativo em `perfis_acesso`
 *
 * O ERP trata 'sem-perfil' como irrestrito de propósito: o gate é fail-open
 * para que um tenant que ainda não configurou perfis não fique trancado fora
 * do próprio sistema. Faz sentido para TELAS — ninguém perde acesso ao que já
 * usava. Não faz sentido para CHAMADO: chamado é conversa, e pode ter dado de
 * folha, de cobrança ou de erro que o colega não precisa ler. Hoje nenhum dos
 * tenants tem perfil cadastrado, o que significa que, sob a regra genérica,
 * todo funcionário leria o chamado de todo mundo.
 *
 * Então a Central é mais fechada que o resto, e de propósito: só o
 * administrador real vê a empresa inteira. Quem não tem perfil fica com os
 * próprios chamados, como qualquer usuário comum.
 *
 * ⚠️ Esta é a ÚNICA diferença, e ela vive aqui — `perfis-acesso.js` não foi
 * tocado. O RBAC das outras áreas continua com o fail-open de sempre.
 */
function vePorEmpresa(db, user) {
  try {
    return acessoDoUsuario(db, user).motivo === 'admin';
  } catch {
    return false;   // na dúvida, o usuário vê só o que é dele
  }
}

/** O que o cliente pode saber de um chamado. Nada de id interno nem auditoria. */
function chamadoPublico(c) {
  return {
    id: c.id,
    numero: c.numero,
    assunto: c.assunto,
    descricao: c.descricao,
    categoria: c.categoria_nome || null,
    categoriaSlug: c.categoria_slug || null,
    status: c.status,
    criadoEm: c.created_at,
    atualizadoEm: c.updated_at,
    resolvidoEm: c.resolvido_at || null,
    abertoPor: c.aberto_por_nome || null,
    reaberturas: c.reaberturas,
    podeReabrir: repo.podeReabrir(c).pode,
    podeResponder: c.status !== 'encerrado',
  };
}

/** O que o cliente pode saber de uma mensagem. Sem autor_id, sem `interna`. */
function mensagemPublica(m) {
  return {
    id: m.id,
    de: m.autor_tipo === 'equipe' ? 'equipe' : 'voce',
    autor: m.autor_nome || (m.autor_tipo === 'equipe' ? 'Suporte Licite Agora' : null),
    corpo: m.corpo,
    em: m.created_at,
  };
}

function registrarRotasSuporte(app, db, controlDb) {
  if (!controlDb) {
    // Single-tenant (scheduler): sem control.db não há onde guardar chamado.
    return { registrado: false, motivo: 'sem controlDb' };
  }

  /** Porta de entrada de toda rota: sessão viva e tenant resolvido pelo host. */
  const exigirContexto = (req, res) => {
    const tenantId = tenantDaSessao(req);
    if (!tenantId) {
      res.status(400).json({ success: false, error: 'Requisição fora do contexto de uma empresa' });
      return null;
    }
    if (!req.user || !req.user.id) {
      res.status(401).json({ success: false, error: 'Não autenticado' });
      return null;
    }
    return { tenantId, user: req.user };
  };

  // ── categorias ────────────────────────────────────────────────────────────
  app.get('/api/suporte/categorias', (req, res) => {
    try {
      if (!exigirContexto(req, res)) return;
      const categorias = repo.listarCategoriasAtivas(controlDb)
        .map((c) => ({ id: c.id, slug: c.slug, nome: c.nome, descricao: c.descricao }));
      res.json({ success: true, categorias });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ── meus chamados ─────────────────────────────────────────────────────────
  app.get('/api/suporte/chamados', (req, res) => {
    try {
      const ctx = exigirContexto(req, res);
      if (!ctx) return;

      /* Usuário comum vê os próprios; quem é irrestrito vê os da empresa.
         O recorte é decidido AQUI, no servidor, e vira filtro de consulta —
         não é uma lista completa podada depois. */
      const daEmpresa = vePorEmpresa(db, ctx.user);
      const filtros = daEmpresa ? {} : { abertoPorUserId: ctx.user.id };
      if (req.query.status) filtros.status = String(req.query.status);

      const chamados = repo.listarChamadosDoTenant(controlDb, ctx.tenantId, filtros)
        .map(chamadoPublico);
      res.json({ success: true, chamados, escopo: daEmpresa ? 'empresa' : 'proprios' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ── abrir ─────────────────────────────────────────────────────────────────
  app.post('/api/suporte/chamados', (req, res) => {
    try {
      const ctx = exigirContexto(req, res);
      if (!ctx) return;
      const b = req.body || {};

      /* `b.prioridade` NÃO é lido. A prioridade sai da categoria, dentro do
         repositório — ver a nota em criarChamadoDoTenant. */
      const criado = repo.criarChamadoDoTenant(controlDb, ctx.tenantId, {
        assunto: b.assunto,
        descricao: b.descricao,
        categoriaId: b.categoriaId,
        abertoPorUserId: ctx.user.id,
        abertoPorNome: ctx.user.nome || ctx.user.username,
        abertoPorEmail: ctx.user.email || null,
      });
      const chamado = repo.buscarChamadoDoTenant(controlDb, ctx.tenantId, criado.id);
      res.status(201).json({ success: true, chamado: chamadoPublico(chamado) });
    } catch (err) {
      // Erro de validação do repositório é 400, não 500: o pedido é que está errado.
      const validacao = /obrigatóri|inválid|inexistente|caracteres|categoria/i.test(err.message);
      res.status(validacao ? 400 : 500).json({ success: false, error: err.message });
    }
  });

  // ── ver um ────────────────────────────────────────────────────────────────
  app.get('/api/suporte/chamados/:id', (req, res) => {
    try {
      const ctx = exigirContexto(req, res);
      if (!ctx) return;

      const chamado = repo.buscarChamadoDoTenant(controlDb, ctx.tenantId, req.params.id);
      if (!chamado) return naoEncontrado(res);

      /* Dentro da própria empresa ainda há recorte: o usuário comum não lê o
         chamado que um colega abriu. Mesma resposta de inexistente. */
      if (!vePorEmpresa(db, ctx.user) && chamado.aberto_por_user_id !== ctx.user.id) {
        return naoEncontrado(res);
      }

      const mensagens = repo.listarMensagensDoTenant(controlDb, ctx.tenantId, chamado.id) || [];
      res.json({
        success: true,
        chamado: chamadoPublico(chamado),
        mensagens: mensagens.map(mensagemPublica),
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ── responder ─────────────────────────────────────────────────────────────
  app.post('/api/suporte/chamados/:id/mensagens', (req, res) => {
    try {
      const ctx = exigirContexto(req, res);
      if (!ctx) return;

      const chamado = repo.buscarChamadoDoTenant(controlDb, ctx.tenantId, req.params.id);
      if (!chamado) return naoEncontrado(res);
      if (!vePorEmpresa(db, ctx.user) && chamado.aberto_por_user_id !== ctx.user.id) {
        return naoEncontrado(res);
      }

      /* `interna` não é lido: pelo lado do cliente a mensagem é sempre
         pública, e o repositório nem oferece o parâmetro. Mesmo que passasse,
         o CHECK do banco recusaria — o autor é 'cliente'. */
      const id = repo.responderChamadoDoTenant(controlDb, ctx.tenantId, chamado.id, {
        corpo: (req.body || {}).corpo,
        autorId: ctx.user.id,
        autorNome: ctx.user.nome || ctx.user.username,
      });
      if (id == null) return naoEncontrado(res);
      res.status(201).json({ success: true, id });
    } catch (err) {
      const validacao = /obrigatóri|inválid|caracteres|encerrado/i.test(err.message);
      res.status(validacao ? 400 : 500).json({ success: false, error: err.message });
    }
  });

  // ── reabrir ───────────────────────────────────────────────────────────────
  app.post('/api/suporte/chamados/:id/reabrir', (req, res) => {
    try {
      const ctx = exigirContexto(req, res);
      if (!ctx) return;

      const chamado = repo.buscarChamadoDoTenant(controlDb, ctx.tenantId, req.params.id);
      if (!chamado) return naoEncontrado(res);
      if (!vePorEmpresa(db, ctx.user) && chamado.aberto_por_user_id !== ctx.user.id) {
        return naoEncontrado(res);
      }

      const r = repo.reabrirChamadoDoTenant(controlDb, ctx.tenantId, chamado.id, {
        corpo: (req.body || {}).corpo,
        autorId: ctx.user.id,
        autorNome: ctx.user.nome || ctx.user.username,
      });
      if (r == null) return naoEncontrado(res);
      res.json({ success: true, ...r });
    } catch (err) {
      const validacao = /obrigatóri|inválid|caracteres|encerrado|prazo|andamento|reaberto/i.test(err.message);
      res.status(validacao ? 400 : 500).json({ success: false, error: err.message });
    }
  });

  return { registrado: true };
}

module.exports = { registrarRotasSuporte, chamadoPublico, mensagemPublica, vePorEmpresa };
