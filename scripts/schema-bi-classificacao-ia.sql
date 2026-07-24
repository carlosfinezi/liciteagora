-- Aplicar em catalog.db (compartilhada).
-- Já aplicado em produção em 2026-05-21.
-- Usado por: /api/bi/classificar-ia (background job) e /api/bi/pesquisar?apenasIaValidados=true
--
-- Por que catalog.db (não tenant DB)?
-- Itens são compartilhados entre tenants. Se DeepSeek classifica "item X é NAS"
-- pra o tenant A, esse veredito vale pro tenant B também (mesmo item, mesma
-- descrição). O escopo (ex: 'grupo_14_nas') é livre — cada grupo de cada tenant
-- pode ter sua própria classificação independente sob escopo distinto.

CREATE TABLE IF NOT EXISTS bi_item_classificacao_ia (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  itemId INTEGER NOT NULL,
  escopo TEXT NOT NULL,                -- ex: 'grupo_14_nas', 'grupo_2_ssl'
  ehAprovado INTEGER NOT NULL,         -- 1 = pertence ao escopo, 0 = ruído
  motivo TEXT,                          -- razão da classificação (curto, da IA)
  modelo TEXT DEFAULT 'deepseek-chat',
  classificadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(itemId, escopo)
);
CREATE INDEX IF NOT EXISTS idx_bi_class_escopo_aprovado ON bi_item_classificacao_ia(escopo, ehAprovado);
CREATE INDEX IF NOT EXISTS idx_bi_class_itemId ON bi_item_classificacao_ia(itemId);
