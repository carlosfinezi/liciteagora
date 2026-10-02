/**
 * whatsapp-canais.js — os números de WhatsApp de uma empresa.
 *
 * ── Por que existe ─────────────────────────────────────────────────────────
 *
 * Até 2026-09-28 cada empresa tinha UM número: a `whatsapp_config` guardava uma
 * instância da Evolution, e tudo (envio, ritmo, atendente de IA, horário,
 * conversas, campanhas) supunha esse número único. Agora são vários, cada um
 * com seu atendente de IA, seu horário e seu ritmo. A Base da IA (ia_base)
 * continua uma só para a empresa.
 *
 * ── A configuração de cada número ──────────────────────────────────────────
 *
 * Mora em `whatsapp_canais.config`, como um mapa com AS MESMAS CHAVES que a
 * empresa guardava na tabela `config` (whatsapp_ai_prompt, whatsapp_ai_tom,
 * whatsapp_horario_faixas...) e na `whatsapp_config` (limite_hora...). Assim
 * as funções que já existiam e são testadas (lerEstilo, lerHorario, o ritmo)
 * seguem as mesmas, lendo de outro lugar pelo `getter` do número. As chaves da
 * empresa ficaram no banco, sem leitura: a migração copiou-as para o número 1.
 *
 * O número PADRÃO é o das mensagens do sistema (cobrança, PIX, OS, confirmação
 * de reunião, pedido ao fornecedor) e o de quem não diz por qual número sai.
 *
 * ── A migração (migrarCanais, chamada pelo db-schema.js no boot) ────────────
 *
 * 1. cria a tabela e as colunas `canalId` onde o envio precisa registrar o
 *    número (whatsapp_queue, wa_campanha_dest, comm_envios) e a lista de
 *    números da campanha nova (comm_campanhas.canais);
 * 2. se a empresa tinha número e ainda não tem canal, cria o canal a partir
 *    da `whatsapp_config` e das chaves da `config`, marcado como padrão;
 * 3. carimba o canal padrão no que já foi enviado e nas mensagens sem
 *    instância;
 * 4. reconstrói `conv_conversas` com `canalId` na chave única: é uma conversa
 *    por contato E número (decisão de 28/09). As conversas existentes viram do
 *    número padrão, com os mesmos ids.
 *
 * Tudo idempotente: rodar de novo não muda nada.
 */
'use strict';

// As chaves que passaram a ser de cada número.
const CHAVES_DO_CANAL = [
  'whatsapp_ai_enabled', 'whatsapp_ai_prompt', 'whatsapp_ai_escopo',
  'whatsapp_ai_tom', 'whatsapp_ai_tamanho', 'whatsapp_ai_emoji', 'whatsapp_ai_limites',
  'whatsapp_horario_ativo', 'whatsapp_horario_faixas', 'whatsapp_horario_msg',
  'limite_hora', 'intervalo_min_s', 'limite_dia',
  // As duas respostas prontas do atendimento (02/10/2026). Moram no NÚMERO, e
  // não no roteiro, porque quem vê um anúncio e pergunta o link nunca passou
  // por campanha nenhuma. O gatilho continua no código (`roteiros.desvioPedido`).
  'whatsapp_ai_resp_pessoa', 'whatsapp_ai_resp_material',
];

// Colunas de conv_conversas, na ordem da reconstrução. Qualquer coluna que a
// tabela tenha e não esteja aqui faz a migração RECUSAR, em vez de perdê-la.
const COLUNAS_CONVERSA = [
  'id', 'canal', 'jid', 'telefone', 'nome', 'pessoaId', 'estado', 'donoId', 'etiquetas',
  'naoLidas', 'iaAtiva', 'ultimaMensagem', 'ultimaEm', 'primeiraRespostaEm', 'resolvidaEm',
  'dataCriacao', 'pedidoId', 'oportunidadeId', 'canalId',
];

const DDL_CONVERSAS = (nome) => `
  CREATE TABLE ${nome} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canal TEXT NOT NULL DEFAULT 'whatsapp',
    jid TEXT NOT NULL,
    telefone TEXT,
    nome TEXT,
    pessoaId INTEGER,
    estado TEXT NOT NULL DEFAULT 'aberta',
    donoId INTEGER,
    etiquetas TEXT,
    naoLidas INTEGER NOT NULL DEFAULT 0,
    iaAtiva INTEGER NOT NULL DEFAULT 1,
    ultimaMensagem TEXT,
    ultimaEm TEXT,
    primeiraRespostaEm TEXT,
    resolvidaEm TEXT,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    pedidoId INTEGER,
    oportunidadeId INTEGER,
    -- 0 = conversa de antes de haver número cadastrado.
    canalId INTEGER NOT NULL DEFAULT 0,
    UNIQUE(canal, jid, canalId)
  )`;

const temTabela = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
const colunas = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
const addColuna = (db, t, def) => {
  if (!temTabela(db, t)) return;
  const nome = def.split(' ')[0];
  if (!colunas(db, t).includes(nome)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${def}`);
};

function criarTabela(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_canais (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      instance TEXT NOT NULL UNIQUE,
      baseUrl TEXT,
      apikey TEXT,
      padrao INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1,
      config TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/** A conversa por contato E número. Chamada também por quem cria a tabela. */
function reconstruirConversas(db, canalPadraoId) {
  if (!temTabela(db, 'conv_conversas')) return false;
  const atuais = colunas(db, 'conv_conversas');
  if (atuais.includes('canalId')) return false;
  const desconhecidas = atuais.filter(c => !COLUNAS_CONVERSA.includes(c));
  if (desconhecidas.length) {
    throw new Error('conv_conversas tem coluna que a migração de números não conhece: ' + desconhecidas.join(', '));
  }
  const copiar = atuais.join(', ');
  const antes = db.prepare('SELECT COUNT(*) n FROM conv_conversas').get().n;
  db.transaction(() => {
    db.exec(DDL_CONVERSAS('conv_conversas_canais'));
    db.prepare(`INSERT INTO conv_conversas_canais (${copiar}, canalId) SELECT ${copiar}, ? FROM conv_conversas`)
      .run(canalPadraoId || 0);
    const depois = db.prepare('SELECT COUNT(*) n FROM conv_conversas_canais').get().n;
    if (depois !== antes) throw new Error(`reconstrução de conv_conversas copiou ${depois} de ${antes}`);
    db.exec('DROP TABLE conv_conversas');
    db.exec('ALTER TABLE conv_conversas_canais RENAME TO conv_conversas');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conv_estado ON conv_conversas(estado, ultimaEm DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conv_pessoa ON conv_conversas(pessoaId)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conv_canal ON conv_conversas(canalId)');
  })();
  return true;
}

function migrarCanais(db) {
  criarTabela(db);
  addColuna(db, 'whatsapp_queue', 'canalId INTEGER');
  addColuna(db, 'wa_campanha_dest', 'canalId INTEGER');
  addColuna(db, 'comm_envios', 'canalId INTEGER');
  addColuna(db, 'comm_campanhas', 'canais TEXT');

  // O número que a empresa já tinha vira o canal 1, padrão, com as chaves dela.
  const vazio = !db.prepare('SELECT 1 FROM whatsapp_canais LIMIT 1').get();
  if (vazio && temTabela(db, 'whatsapp_config')) {
    const w = Object.fromEntries(db.prepare('SELECT key, value FROM whatsapp_config').all().map(r => [r.key, r.value]));
    if (w.provider === 'evolution' && w.instance) {
      const config = {};
      if (temTabela(db, 'config')) {
        for (const r of db.prepare(`SELECT chave, valor FROM config WHERE chave IN (${CHAVES_DO_CANAL.map(() => '?').join(',')})`)
          .all(...CHAVES_DO_CANAL)) {
          if (r.valor != null) config[r.chave] = r.valor;
        }
      }
      for (const k of ['limite_hora', 'intervalo_min_s', 'limite_dia']) if (w[k] != null) config[k] = w[k];
      db.prepare(`INSERT INTO whatsapp_canais (nome, instance, baseUrl, apikey, padrao, config)
        VALUES ('Principal', ?, ?, ?, 1, ?)`).run(w.instance, w.baseUrl || null, w.apikey || null, JSON.stringify(config));
    }
  }

  const padrao = canalPadrao(db);
  if (padrao) {
    // O que já saiu, saiu pelo único número que existia.
    if (temTabela(db, 'whatsapp_queue')) db.prepare('UPDATE whatsapp_queue SET canalId = ? WHERE canalId IS NULL').run(padrao.id);
    if (temTabela(db, 'wa_campanha_dest')) {
      db.prepare("UPDATE wa_campanha_dest SET canalId = ? WHERE canalId IS NULL AND status <> 'pendente'").run(padrao.id);
    }
    if (temTabela(db, 'comm_envios')) {
      db.prepare("UPDATE comm_envios SET canalId = ? WHERE canalId IS NULL AND status <> 'pendente'").run(padrao.id);
    }
    // /send e /responder gravavam sem instância: foram pelo único número.
    if (temTabela(db, 'whatsapp_messages')) {
      db.prepare('UPDATE whatsapp_messages SET instance = ? WHERE instance IS NULL').run(padrao.instance);
    }
  }
  reconstruirConversas(db, padrao && padrao.id);
}

// ==================== leitura ====================

const lerConfig = (t) => { try { return JSON.parse(t || '{}') || {}; } catch { return {}; } };
const montar = (r) => (r ? { ...r, padrao: !!r.padrao, ativo: !!r.ativo, config: lerConfig(r.config) } : null);

function listarCanais(db, { incluirInativos = false } = {}) {
  try {
    return db.prepare(`SELECT * FROM whatsapp_canais ${incluirInativos ? '' : 'WHERE ativo = 1'}
      ORDER BY padrao DESC, id`).all().map(montar);
  } catch { return []; }
}

function canalPorId(db, id) {
  try { return montar(db.prepare('SELECT * FROM whatsapp_canais WHERE id = ? AND ativo = 1').get(Number(id))); }
  catch { return null; }
}

function canalPorInstance(db, instance) {
  try { return montar(db.prepare('SELECT * FROM whatsapp_canais WHERE instance = ? AND ativo = 1').get(String(instance || ''))); }
  catch { return null; }
}

/** O padrão; sem padrão marcado, o primeiro ativo. */
function canalPadrao(db) {
  try {
    return montar(db.prepare('SELECT * FROM whatsapp_canais WHERE ativo = 1 ORDER BY padrao DESC, id LIMIT 1').get());
  } catch { return null; }
}

/** O número pedido, ou o padrão quando não se pediu nenhum. */
function canalOuPadrao(db, id) {
  return id ? canalPorId(db, id) : canalPadrao(db);
}

/** Leitor das chaves do número, no formato que lerEstilo e lerHorario esperam. */
function getterDoCanal(canal) {
  const c = (canal && canal.config) || {};
  return (chave) => (c[chave] == null ? '' : String(c[chave]));
}

/** Grava só as chaves do número; as demais são recusadas por quem chama. */
function salvarConfigCanal(db, id, mudancas) {
  const canal = canalPorId(db, id);
  if (!canal) throw new Error('Número não encontrado');
  const config = { ...canal.config };
  for (const [k, v] of Object.entries(mudancas || {})) {
    if (!CHAVES_DO_CANAL.includes(k)) throw new Error('Chave que não é do número: ' + k);
    if (v == null || v === '') delete config[k]; else config[k] = String(v);
  }
  db.prepare('UPDATE whatsapp_canais SET config = ? WHERE id = ?').run(JSON.stringify(config), canal.id);
  return canalPorId(db, canal.id);
}

/**
 * Os números por onde uma campanha sai: os escolhidos nela que continuam
 * ativos, ou, sem escolha, só o padrão. Com mais de um, os envios se revezam
 * entre eles (decisão de 28/09: dividir o volume entre os chips).
 *
 * `{ erro }` quando a campanha escolheu números e nenhum existe mais: cair no
 * padrão mandaria por um número que ninguém escolheu.
 */
function numerosDaCampanha(db, ids) {
  const escolhidos = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
  if (!escolhidos.length) {
    const p = canalPadrao(db);
    return p ? { numeros: [p] } : { numeros: [], erro: 'Nenhum número de WhatsApp conectado a esta empresa' };
  }
  const numeros = escolhidos.map(id => canalPorId(db, id)).filter(Boolean);
  if (!numeros.length) return { numeros, erro: 'Os números escolhidos para esta campanha foram removidos. Escolha outro' };
  return { numeros };
}

/** Recusa lista de números que não sejam da empresa; devolve os ids limpos. */
function validarNumeros(db, ids) {
  if (ids == null) return [];
  if (!Array.isArray(ids)) throw new Error('Números da campanha em formato inválido');
  const limpos = [...new Set(ids.map(Number).filter(Boolean))];
  for (const id of limpos) if (!canalPorId(db, id)) throw new Error('Número de WhatsApp não encontrado: ' + id);
  return limpos;
}

module.exports = {
  numerosDaCampanha, validarNumeros,
  CHAVES_DO_CANAL, criarTabela, migrarCanais, reconstruirConversas, DDL_CONVERSAS,
  listarCanais, canalPorId, canalPorInstance, canalPadrao, canalOuPadrao, getterDoCanal, salvarConfigCanal,
};
