'use strict';
/**
 * suporte-schema.js — as tabelas da Central de Suporte, no control.db.
 *
 * ── Por que no control.db, e não no banco de cada tenant ────────────────────
 *
 * O chamado não é dado do negócio do cliente: é da relação entre a plataforma
 * e a empresa. Três consequências práticas decidiram isso:
 *
 *   1. a equipe precisa listar, filtrar e ordenar os chamados de TODAS as
 *      empresas numa tela só. No banco de cada tenant isso exigiria abrir os
 *      25 bancos a cada clique de filtro — e o maior deles tem 756 MB;
 *   2. o histórico de suporte tem de sobreviver ao encerramento do cliente;
 *   3. o volume é desprezível para este arquivo: o control.db tem 188 KB, e
 *      25 empresas × 50 chamados/ano × 10 mensagens dão ~12 mil linhas por ano.
 *
 * O preço é que o isolamento deixa de ser físico e passa a ser de código. É por
 * isso que ele não mora aqui espalhado em `WHERE`: mora no `suporte-repo.js`,
 * em funções que não compilam uma consulta sem o tenant.
 *
 * ── O mecanismo é o que já existe ───────────────────────────────────────────
 *
 * Mesmo molde de `plan-modules.js` e `module-gate.js`: um módulo exporta
 * `ensure…Schema(db)` com `CREATE TABLE IF NOT EXISTS` e seeds idempotentes, e
 * o `initControlDb` do `tenant-manager.js` o chama no boot. Nada de segundo
 * sistema de migração, e nada no `db-schema.js`, que é dos tenants.
 *
 * ── Duas guardas que ficam no BANCO, e não na rota ──────────────────────────
 *
 * - `CHECK (interna = 0 OR autor_tipo = 'equipe')`: nota interna é da equipe.
 *   Um bug de rota que deixasse o cliente marcar `interna = 1` esconderia a
 *   mensagem dele do próprio histórico; o banco recusa antes.
 * - `ON DELETE RESTRICT` no tenant: apagar uma empresa com chamado passa a ser
 *   impossível. Não trava nada hoje — não existe `DELETE FROM tenants` no
 *   sistema, a saída de um cliente é `status = SUSPENDED` —, e é justamente o
 *   que garante o item 2 lá de cima.
 */

/** Os estados pelos quais um chamado passa. A ordem é a do ciclo. */
const STATUS = ['aberto', 'em_atendimento', 'aguardando_cliente', 'resolvido', 'encerrado'];

/** Prioridades, da menor para a maior. */
const PRIORIDADES = ['baixa', 'normal', 'alta', 'urgente'];

/** Quem escreve numa mensagem. 'sistema' é mudança automática registrada. */
const AUTOR_TIPOS = ['cliente', 'equipe', 'sistema'];

/**
 * Categorias iniciais. São SEED, não regra: o `slug` é a chave de
 * idempotência, e quem precisar decidir algo por categoria consulta a tabela,
 * nunca esta lista. O `sla_horas` aqui é só o ponto de partida; a Fase 6 o
 * torna editável no painel.
 */
const CATEGORIAS_SEED = [
  { slug: 'duvida', nome: 'Dúvida', prioridade_padrao: 'normal', sla_horas: 24, ordem: 1 },
  { slug: 'problema-tecnico', nome: 'Problema técnico', prioridade_padrao: 'alta', sla_horas: 8, ordem: 2 },
  { slug: 'financeiro', nome: 'Financeiro/assinatura', prioridade_padrao: 'alta', sla_horas: 8, ordem: 3 },
  { slug: 'fiscal', nome: 'Fiscal', prioridade_padrao: 'alta', sla_horas: 8, ordem: 4 },
  { slug: 'cadastro-configuracao', nome: 'Cadastro/configuração', prioridade_padrao: 'normal', sla_horas: 24, ordem: 5 },
  { slug: 'sugestao', nome: 'Sugestão de melhoria', prioridade_padrao: 'baixa', sla_horas: null, ordem: 6 },
  { slug: 'outro', nome: 'Outro', prioridade_padrao: 'normal', sla_horas: 24, ordem: 7 },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS suporte_categorias (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,
  nome              TEXT NOT NULL,
  descricao         TEXT,
  prioridade_padrao TEXT NOT NULL DEFAULT 'normal',
  sla_horas         INTEGER,
  ativo             INTEGER NOT NULL DEFAULT 1,
  ordem             INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS suporte_chamados (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id            INTEGER NOT NULL,
  numero               TEXT NOT NULL UNIQUE,
  categoria_id         INTEGER,
  assunto              TEXT NOT NULL,
  descricao            TEXT NOT NULL,
  prioridade           TEXT NOT NULL DEFAULT 'normal',
  status               TEXT NOT NULL DEFAULT 'aberto',
  aberto_por_user_id   INTEGER,
  aberto_por_nome      TEXT,
  aberto_por_email     TEXT,
  responsavel_admin_id INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  primeira_resposta_at INTEGER,
  resolvido_at         INTEGER,
  encerrado_at         INTEGER,
  sla_vence_at         INTEGER,
  reaberturas          INTEGER NOT NULL DEFAULT 0,
  CHECK (status IN ('aberto','em_atendimento','aguardando_cliente','resolvido','encerrado')),
  CHECK (prioridade IN ('baixa','normal','alta','urgente')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (categoria_id) REFERENCES suporte_categorias(id) ON DELETE SET NULL,
  FOREIGN KEY (responsavel_admin_id) REFERENCES super_admins(id) ON DELETE SET NULL
);

/* O par (tenant_id, …) vem PRIMEIRO em todo índice de leitura do cliente:
   é a coluna que toda consulta dele filtra, e é o que mantém a varredura
   restrita à empresa mesmo quando a tabela crescer. */
CREATE INDEX IF NOT EXISTS idx_suporte_chamados_tenant     ON suporte_chamados(tenant_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_suporte_chamados_fila       ON suporte_chamados(status, sla_vence_at);
CREATE INDEX IF NOT EXISTS idx_suporte_chamados_responsav  ON suporte_chamados(responsavel_admin_id, status);
CREATE INDEX IF NOT EXISTS idx_suporte_chamados_categoria  ON suporte_chamados(categoria_id);

CREATE TABLE IF NOT EXISTS suporte_mensagens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chamado_id INTEGER NOT NULL,
  autor_tipo TEXT NOT NULL,
  autor_id   INTEGER,
  autor_nome TEXT,
  corpo      TEXT NOT NULL,
  interna    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  CHECK (autor_tipo IN ('cliente','equipe','sistema')),
  CHECK (interna IN (0,1)),
  CHECK (interna = 0 OR autor_tipo = 'equipe'),
  FOREIGN KEY (chamado_id) REFERENCES suporte_chamados(id) ON DELETE CASCADE
);

/* "interna" entra no índice porque a leitura do cliente filtra por ela em
   TODA consulta de mensagem — é o caminho quente, não um filtro ocasional. */
CREATE INDEX IF NOT EXISTS idx_suporte_mensagens_chamado ON suporte_mensagens(chamado_id, interna, created_at);

CREATE TABLE IF NOT EXISTS suporte_historico (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chamado_id INTEGER NOT NULL,
  action     TEXT NOT NULL,
  actor_tipo TEXT NOT NULL,
  actor_id   INTEGER,
  actor_nome TEXT,
  payload    TEXT,
  at         INTEGER NOT NULL,
  CHECK (actor_tipo IN ('cliente','equipe','sistema')),
  FOREIGN KEY (chamado_id) REFERENCES suporte_chamados(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_suporte_historico_chamado ON suporte_historico(chamado_id, at);
`;

/**
 * Cria o schema e semeia as categorias. Idempotente: pode rodar a cada boot.
 * @param {import('better-sqlite3').Database} db  conexão do control.db
 */
function ensureSuporteSchema(db) {
  db.exec(SCHEMA);

  /* INSERT OR IGNORE pelo `slug` UNIQUE, como o seed de planos do
     tenant-manager: rodar de novo não duplica e NÃO sobrescreve o que o
     administrador tiver editado depois (nome, SLA, ordem). */
  const ins = db.prepare(`
    INSERT OR IGNORE INTO suporte_categorias
      (slug, nome, descricao, prioridade_padrao, sla_horas, ativo, ordem, created_at)
    VALUES (@slug, @nome, NULL, @prioridade_padrao, @sla_horas, 1, @ordem, @created_at)
  `);
  const agora = Date.now();
  const tx = db.transaction(() => {
    for (const c of CATEGORIAS_SEED) {
      if (!PRIORIDADES.includes(c.prioridade_padrao)) {
        throw new Error(`suporte-schema: prioridade inválida "${c.prioridade_padrao}" na categoria ${c.slug}`);
      }
      ins.run({ ...c, sla_horas: c.sla_horas ?? null, created_at: agora });
    }
  });
  tx();
}

module.exports = { ensureSuporteSchema, STATUS, PRIORIDADES, AUTOR_TIPOS, CATEGORIAS_SEED };
