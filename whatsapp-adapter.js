/**
 * whatsapp-adapter.js — Camada plugável para envio de WhatsApp
 *
 * Comportamento atual: enfileira a mensagem no banco (tabela whatsapp_queue).
 * Quando um provider for escolhido (Evolution, Z-API, Meta Cloud API),
 * implementar o dispatch real em dispatchViaProvider(db, item).
 *
 * O frontend pode consumir /api/whatsapp/queue para enviar manualmente
 * (abrir wa.me em massa) enquanto não houver provider configurado.
 */

// Credenciais globais do Evolution (systemd Environment). Cada número pode ter
// as próprias (whatsapp_canais.baseUrl/apikey, como o `status1bit` do 1bit);
// sem elas, valem estas.
const canais = require('./whatsapp-canais');
const EVOLUTION_URL = process.env.EVOLUTION_URL || '';
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY || '';

const WEBHOOK_URL = process.env.EVOLUTION_WEBHOOK_URL || 'http://localhost:3000/api/whatsapp/webhook';

const DEFAULT_ATEND = 'Você é o atendente virtual desta empresa no WhatsApp. Responda em português, de forma breve e cordial.';
const KB_SEP = '\n\n=== BASE DE CONHECIMENTO ===\n\n';

// Garantia 1 (nunca silêncio): quando a IA roda mas o LLM vem vazio/falha, devolve isto
// em vez de nada. Usado pelo atendimento real (autoResponder) e pelo simulador.
const FALLBACK_SEM_RESPOSTA = 'Recebi sua mensagem! Já te retorno por aqui.';

// Garantia 2 (interina, anti-alucinação): guard-rail mínimo pra IA não inventar fato quando
// a base é seca. A trava completa + escalonamento pro humano é a Parte 2 (ver TODO abaixo).
const GUARDRAIL_INTERINO = 'Responda apenas com o que estiver nesta base. Se não tiver a informação (preço, produto, arquivo, prazo ou qualquer dado específico), NÃO invente: diga de forma breve que vai confirmar e retornar. Prefira ser vago a criar um fato.';

/**
 * Tom e limites, como escolha e não como texto solto.
 *
 * Antes, isso morava dentro do campo livre de instruções, junto da identidade
 * do assistente, da descrição do produto e dos contatos. Escrever "seja
 * conciso" à mão funciona, mas ninguém tem como saber o que já foi dito, e o
 * campo do `1bit` chegou a 2.995 caracteres com as duas coisas misturadas.
 *
 * A frase que vai ao modelo é a daqui, fixa. O que o tenant guarda é o id da
 * escolha, então trocar a redação de uma frase vale para todos de uma vez,
 * sem migration nem reescrita de texto de ninguém.
 *
 * Tenant sem escolha nenhuma gravada não recebe frase nenhuma: o prompt fica
 * exatamente como era antes desta seção existir.
 */
const ESTILO = {
  tom: {
    rotulo: 'Tom', chave: 'whatsapp_ai_tom', escolha: 'uma',
    opcoes: [
      { id: 'proximo', rotulo: 'Profissional e próximo',
        frase: 'Fale em tom profissional e próximo, sem formalidade exagerada.' },
      { id: 'formal', rotulo: 'Formal',
        frase: 'Fale em tom formal, tratando a pessoa por senhor ou senhora.' },
      { id: 'direto', rotulo: 'Direto ao ponto',
        frase: 'Vá direto ao ponto, sem rodeio nem saudação longa.' },
      { id: 'caloroso', rotulo: 'Caloroso',
        frase: 'Fale de forma acolhedora e simpática, com interesse por quem escreveu.' },
    ],
  },
  tamanho: {
    rotulo: 'Tamanho da resposta', chave: 'whatsapp_ai_tamanho', escolha: 'uma',
    opcoes: [
      { id: 'curta', rotulo: 'Curta',
        frase: 'Responda em um a três parágrafos curtos. Evite respostas longas.' },
      { id: 'media', rotulo: 'Média',
        frase: 'Responda com o detalhe necessário, em até cinco parágrafos.' },
      { id: 'livre', rotulo: 'Sem limite',
        frase: 'Responda com o tamanho que o assunto exigir.' },
    ],
  },
  emoji: {
    rotulo: 'Emoji', chave: 'whatsapp_ai_emoji', escolha: 'uma',
    opcoes: [
      { id: 'nenhum', rotulo: 'Nenhum', frase: 'Não use emoji.' },
      { id: 'ate1', rotulo: 'No máximo um',
        frase: 'Use no máximo um emoji por mensagem, e apenas quando couber.' },
      { id: 'livre', rotulo: 'À vontade', frase: 'Pode usar emoji à vontade.' },
    ],
  },
  limites: {
    rotulo: 'O que ela nunca faz', chave: 'whatsapp_ai_limites', escolha: 'varias',
    opcoes: [
      { id: 'dado_sensivel', rotulo: 'Pedir senha ou dado bancário',
        frase: 'Nunca peça senha, dado bancário ou documento sensível.' },
      { id: 'fora_do_escopo', rotulo: 'Responder fora do assunto da empresa',
        frase: 'Se a pergunta fugir do assunto da empresa, diga que vai encaminhar a um atendente, em vez de responder por conta própria.' },
      { id: 'outro_idioma', rotulo: 'Responder em outro idioma',
        frase: 'Responda sempre em português do Brasil.' },
      { id: 'prometer', rotulo: 'Prometer desconto ou prazo',
        frase: 'Não prometa desconto, prazo de entrega nem condição comercial que não esteja nesta base.' },
      { id: 'insistir', rotulo: 'Insistir em oferta',
        frase: 'Não insista em oferta: sem interesse da pessoa, encerre com cordialidade.' },
    ],
  },
};

/** As escolhas gravadas, já limpas do que não existe mais no catálogo. */
function lerEstilo(getValor) {
  const escolhas = {};
  for (const [grupo, def] of Object.entries(ESTILO)) {
    const bruto = getValor(def.chave) || '';
    const validos = new Set(def.opcoes.map(o => o.id));
    if (def.escolha === 'varias') {
      let lista = [];
      try { lista = JSON.parse(bruto); } catch { lista = bruto ? bruto.split(',') : []; }
      escolhas[grupo] = (Array.isArray(lista) ? lista : []).map(String).filter(id => validos.has(id));
    } else {
      escolhas[grupo] = validos.has(bruto) ? bruto : null;
    }
  }
  return escolhas;
}

/** As frases das escolhas, na ordem do catálogo. Sem escolha, string vazia. */
function frasesDeEstilo(escolhas) {
  const frases = [];
  for (const [grupo, def] of Object.entries(ESTILO)) {
    const sel = escolhas[grupo];
    for (const o of def.opcoes) {
      if (def.escolha === 'varias' ? (sel || []).includes(o.id) : sel === o.id) frases.push(o.frase);
    }
  }
  return frases.join('\n');
}

// Base de atendimento DEDICADA da campanha (atendimento_prompt/_kb). Só é
// chamada quando a campanha declara uma; sem ela, vale a base de todo mundo.
//
// A `persona` e o `briefing` da campanha deixaram de ser lidos em 2026-09-28:
// eram o material da IA que escrevia a primeira mensagem, que saiu. A persona
// do atendente é a de Canal › Instruções da empresa.
function buildAtendimentoBaseCampanha(campCfg) {
  const prompt = campCfg.atendimento_prompt || DEFAULT_ATEND;
  const kb     = campCfg.atendimento_kb || '';
  const corpo  = kb ? prompt + KB_SEP + kb : prompt;
  return corpo + '\n\n' + GUARDRAIL_INTERINO;
}

// FONTE ÚNICA do system prompt do atendimento IA — atendimento REAL (autoResponder) E
// simulador, pra nunca divergirem. Lead de campanha => SEMPRE base da campanha (nunca o
// KB do tenant). Sem campanha (atendimento geral) => KB do tenant, como hoje.
/**
 * Prompt do atendimento.
 *
 * Regra desde 2026-08-14: **todo mundo é atendido pela mesma base**. Antes,
 * quem tinha entrado numa campanha era respondido só pelo texto daquela
 * campanha e nunca enxergava a ia_base — no 1bit isso era 695 contra 19.407
 * caracteres, para a mesma pergunta. Não era decisão de produto: o atendimento
 * de campanha nasceu num sistema separado, antes de a base existir, e o
 * comportamento veio junto na migração.
 *
 * Ter vindo de campanha agora é CONTEXTO, não substituição: entra como mais um
 * bloco no conhecimento, junto com o resto.
 *
 * A exceção continua possível e é declarada: campanha com `atendimento_prompt`
 * ou `atendimento_kb` no config quer mesmo um atendimento próprio (outra
 * oferta, outra marca) e segue com ele.
 */
/**
 * O que a IA ainda precisa descobrir, pelo roteiro de qualificação.
 *
 * Só as perguntas SEM resposta entram: repetir o que já foi apurado gasta token
 * e convida o modelo a perguntar de novo o que o contato já respondeu.
 *
 * As regras de condução vêm junto e por escrito. Um roteiro de cinco perguntas
 * convivendo com "responda em três parágrafos" e "não insista" é instrução que
 * se contradiz, e sem precedência declarada o modelo resolve isso do jeito
 * dele: ou vira interrogatório, ou ignora o roteiro.
 *
 * Sem roteiro cadastrado, ou sem conversa identificada, devolve string vazia e
 * o prompt fica exatamente como era.
 */
// O roteiro de qualificação da conversa (roteiro-conversa.js): a etapa atual e
// como perguntar, ou o que fazer quando o roteiro terminou. Até 29/09 era o
// roteiro de WhatsApp padrão da empresa, com todas as perguntas que faltavam;
// agora é o da campanha que o contato recebeu, uma etapa por vez.
function blocoRoteiro(db, conversaId) {
  return require('./roteiro-conversa').blocoParaIA(db, conversaId);
}

function buildSystemAtendimento(db, campanhaId, opts) {
  let campanha = null;
  if (campanhaId) {
    try {
      const c = db.prepare("SELECT config FROM wa_campanhas WHERE id = ?").get(campanhaId);
      if (c) campanha = JSON.parse(c.config || '{}');
    } catch (_) { }
    if (campanha && (campanha.atendimento_prompt || campanha.atendimento_kb)) {
      return buildAtendimentoBaseCampanha(campanha);
    }
  }
  // Instruções, tom e limites são do NÚMERO que atende; a Base da IA (ia_base,
  // abaixo) é uma só para a empresa.
  const getConfigValue = configDoAtendimento(db, opts && opts.canalId);
  let base = getConfigValue('whatsapp_ai_prompt') || DEFAULT_ATEND;

  // Tom e limites entram logo depois das instruções e antes do conhecimento:
  // são regra de como falar, e o que vem depois é o que se pode dizer.
  const estilo = frasesDeEstilo(lerEstilo((c) => getConfigValue(c)));
  if (estilo) base += '\n\nCOMO RESPONDER\n' + estilo;

  // Conhecimento vem só de ia_base: itens com título, origem e data, editáveis
  // na tela de Conversas e alimentados pelo "corrigir" do atendente.
  //
  // O campo antigo `config.whatsapp_ai_kb` deixou de ser lido em 2026-08-14 —
  // seu conteúdo foi migrado para itens por scripts/migrar-kb-legado.js. Ele
  // era editado por uma tela que saiu do ar na unificação, então continuava
  // entrando no prompt sem que ninguém pudesse ver nem corrigir. O valor segue
  // gravado no config para conferência; não é lido em lugar nenhum.
  let pedacos = '';
  try {
    const itens = db.prepare('SELECT titulo, conteudo FROM ia_base WHERE ativo = 1 ORDER BY id DESC LIMIT 60').all();
    if (itens.length) {
      pedacos = itens.map(i => `### ${i.titulo}\n${i.conteudo}`).join('\n\n');
    }
  } catch { /* tenant ainda sem a tabela */ }

  // Contexto da campanha: saber de onde a pessoa veio muda o tom da resposta,
  // mas não deve tirar dela o acesso ao que a empresa sabe.
  if (campanha) {
    const ctx = '### Contexto: esta pessoa respondeu a uma campanha'
      + (campanha.nome ? ` ("${campanha.nome}")` : '');
    pedacos = pedacos ? ctx + '\n\n' + pedacos : ctx;
  }

  const corpo = pedacos ? base + KB_SEP + pedacos : base;
  // O roteiro vem depois do conhecimento: primeiro o que ela pode dizer, depois
  // o que ela ainda precisa perguntar.
  const roteiro = blocoRoteiro(db, opts && opts.conversaId);
  // O guard-rail anti-invenção vinha só no caminho de campanha. Ele vale para
  // qualquer atendimento: inventar preço com cliente antigo é igualmente ruim.
  return corpo + roteiro + '\n\n' + GUARDRAIL_INTERINO;
}

function evoCreds(cfg) {
  const base = String((cfg && cfg.baseUrl) || EVOLUTION_URL || '').replace(/\/$/, '');
  const apikey = (cfg && cfg.apikey) || EVOLUTION_APIKEY || '';
  return { base, apikey };
}

// Aponta o webhook da instância pro liciteagora (recebimento). Só para instâncias
// 'le_*' — nunca mexe em status1bit (webhook dele vai pro status-bot).
async function setWebhook(base, apikey, instance) {
  if (!instance || !instance.startsWith('le_')) return;
  try {
    await fetch(`${base}/webhook/set/${instance}`, {
      method: 'POST', headers: { apikey, 'content-type': 'application/json' },
      body: JSON.stringify({ webhook: { enabled: true, url: WEBHOOK_URL, webhookByEvents: false, webhookBase64: false, events: ['MESSAGES_UPSERT'] } }),
    });
  } catch (_) { /* best-effort */ }
}

function migrarQueue(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telefone TEXT NOT NULL,
      texto TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      erro TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataEnvio TEXT,
      provider TEXT,
      providerMessageId TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wa_queue_status ON whatsapp_queue(status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_message_id TEXT,
      instance TEXT,
      remote_jid TEXT NOT NULL,
      from_me INTEGER DEFAULT 0,
      from_bot INTEGER DEFAULT 0,
      push_name TEXT,
      texto TEXT,
      message_type TEXT,
      timestamp INTEGER,
      criado_em TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_wa_msg_jid ON whatsapp_messages(remote_jid, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_msg_waid ON whatsapp_messages(wa_message_id) WHERE wa_message_id IS NOT NULL;
  `);
  // tabelas criadas antes da coluna from_bot (migração idempotente)
  try { db.exec('ALTER TABLE whatsapp_messages ADD COLUMN from_bot INTEGER DEFAULT 0'); } catch (_) { /* já existe */ }
  // Por qual número saiu (whatsapp-canais.js). A migração de verdade roda no
  // boot (db-schema.js); aqui só garante a coluna para fila criada depois.
  try { db.exec('ALTER TABLE whatsapp_queue ADD COLUMN canalId INTEGER'); } catch (_) { /* já existe */ }
  canais.criarTabela(db);
}

/**
 * As chaves do atendimento (IA, estilo, horário, ritmo) de um número. Empresa
 * sem número cadastrado segue lendo a tabela `config`, como antes de haver
 * vários números: é o caso do simulador antes da primeira conexão.
 */
function configDoAtendimento(db, canalId) {
  const canal = canais.canalOuPadrao(db, canalId);
  if (canal) return canais.getterDoCanal(canal);
  return (chave) => {
    try { return db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave)?.valor || ''; }
    catch { return ''; }
  };
}

/**
 * As credenciais de UM número: o pedido, ou o padrão. Quem não diz o número
 * (cobrança, PIX, OS, agenda, fornecedor) sai pelo padrão.
 *
 * Empresa ainda sem canal cadastrado cai na `whatsapp_config` antiga, que a
 * migração do boot transforma em canal; o caminho existe para o intervalo
 * entre a edição e o boot, e para quem nunca conectou.
 */
function loadProviderConfig(db, canalId) {
  migrarQueue(db);
  const canal = canais.canalOuPadrao(db, canalId);
  if (canal) {
    return { provider: 'evolution', baseUrl: canal.baseUrl, apikey: canal.apikey, instance: canal.instance,
             canalId: canal.id, canalNome: canal.nome, canal };
  }
  if (canalId) return null;   // pediu um número que não existe: não cai em outro
  const rows = db.prepare('SELECT key, value FROM whatsapp_config').all();
  if (!rows.length) return null;
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  if (!cfg.provider) return null;
  return cfg;
}

/**
 * Envia uma mensagem via provider configurado.
 * Hoje retorna { queued: true } porque nenhum provider está implementado.
 *
 * Interface esperada de retorno:
 *   { success: true, providerMessageId }
 *   { success: false, error }
 *   { queued: true }
 */
// ==================== PROTEÇÃO DO NÚMERO ====================
//
// Em provedor não oficial (Baileys) quem paga a conta do excesso é o chip do
// cliente: volume alto, cadência de robô e mensagem repetida é o que dispara
// denúncia e bloqueio. Estes limites não deixam o WhatsApp "seguro" — nada
// deixa —, mas evitam o padrão que derruba número em dias.
//
// Referência de mercado: manter abaixo de ~30/hora, cadência de ~1/min, e
// número novo começar devagar (20-50/dia na 1ª semana).
const LIMITE_HORA_PADRAO = 25;
const INTERVALO_MIN_S = 45;
const ESCADA_AQUECIMENTO = [
  { ateDias: 3,  limite: 40 },
  { ateDias: 7,  limite: 90 },
  { ateDias: 14, limite: 180 },
];
const LIMITE_DIARIO_MAX = 300;

/** Um limite de ritmo do número (limite_hora, intervalo_min_s, limite_dia). */
const numeroCfg = (cfg, chave, padrao) => {
  const bruto = cfg && cfg.canal ? cfg.canal.config[chave] : cfg && cfg[chave];
  const n = Number(bruto);
  return Number.isFinite(n) && n > 0 ? n : padrao;
};

/**
 * O teto do dia do número: o que foi configurado, ou o do aquecimento, que
 * depende da idade do número nesta operação (40, 90, 180 e depois 300).
 */
function tetoDoDia(db, cfg, filtro) {
  const primeiro = db.prepare(`SELECT MIN(dataEnvio) d FROM whatsapp_queue WHERE status = 'enviado'${filtro}`).get().d;
  let limiteDia = ESCADA_AQUECIMENTO[0].limite;   // primeiro envio: começa no degrau 1
  if (primeiro) {
    const dias = db.prepare("SELECT CAST(julianday('now') - julianday(?) AS INTEGER) d").get(primeiro).d ?? 0;
    limiteDia = (ESCADA_AQUECIMENTO.find(e => dias <= e.ateDias) || {}).limite || LIMITE_DIARIO_MAX;
  }
  return numeroCfg(cfg, 'limite_dia', limiteDia);
}

/**
 * Diz se pode enviar agora PELO NÚMERO de `cfg`. Conta pela própria fila, o
 * que de fato saiu por aquele número: cada chip tem a sua proteção. Sem
 * número cadastrado (fila antiga), conta a fila inteira.
 */
function checarRitmo(db, cfg) {
  try {
    const filtro = cfg && cfg.canalId ? ` AND canalId = ${Number(cfg.canalId)}` : '';
    const hora = db.prepare(`SELECT COUNT(*) n FROM whatsapp_queue
      WHERE status = 'enviado' AND dataEnvio >= datetime('now','-1 hour')${filtro}`).get().n;
    const limiteHora = numeroCfg(cfg, 'limite_hora', LIMITE_HORA_PADRAO);
    if (hora >= limiteHora) {
      return { ok: false, motivo: `limite de ${limiteHora} mensagens por hora atingido (${hora} na última hora)` };
    }

    const ultimo = db.prepare(`SELECT dataEnvio FROM whatsapp_queue
      WHERE status = 'enviado' AND dataEnvio IS NOT NULL${filtro} ORDER BY id DESC LIMIT 1`).get();
    if (ultimo?.dataEnvio) {
      const seg = db.prepare("SELECT CAST((julianday('now') - julianday(?)) * 86400 AS INTEGER) s").get(ultimo.dataEnvio).s;
      const minimo = numeroCfg(cfg, 'intervalo_min_s', INTERVALO_MIN_S);
      if (seg != null && seg < minimo) {
        return { ok: false, motivo: `aguardando intervalo entre envios (faltam ${minimo - seg}s)`, esperar: minimo - seg };
      }
    }

    const limiteDia = tetoDoDia(db, cfg, filtro);
    // Dia de Brasília, não UTC: com date('now') puro o contador zera às 21h
    // local e o teto diário deixa de valer justamente no fim do expediente.
    const hoje = db.prepare(`SELECT COUNT(*) n FROM whatsapp_queue
      WHERE status = 'enviado' AND date(dataEnvio, '-3 hours') = date('now', '-3 hours')${filtro}`).get().n;
    if (hoje >= limiteDia) {
      return { ok: false, motivo: `limite de ${limiteDia} mensagens no dia atingido (aquecimento do número)` };
    }
    return { ok: true };
  } catch { return { ok: true }; }   // sem fila migrada ainda: não trava o envio
}

/**
 * Envia texto pelo número `canalId`, ou pelo padrão. Registra na fila por qual
 * número saiu, que é o que o ritmo de cada número conta.
 *
 * `segurado: true` quer dizer "o ritmo deste número não deixa agora": quem
 * dispara em lote (campanhas) espera e tenta de novo, em vez de parar.
 */
async function enviarWhatsApp(db, { telefone, texto, ignorarRitmo = false, canalId = null }) {
  migrarQueue(db);

  const cfg = loadProviderConfig(db, canalId);
  let telefoneNorm = String(telefone || '').replace(/\D/g, '');
  if (telefoneNorm && !telefoneNorm.startsWith('55')) telefoneNorm = '55' + telefoneNorm;

  if (!telefoneNorm) {
    return { success: false, error: 'Telefone invalido' };
  }
  if (canalId && !cfg) return { success: false, error: 'Número de WhatsApp não encontrado ou removido' };
  const cid = (cfg && cfg.canalId) || null;

  if (!cfg) {
    // Enfileira para envio manual/posterior
    const id = db.prepare(
      'INSERT INTO whatsapp_queue (telefone, texto, status, canalId) VALUES (?, ?, ?, ?)'
    ).run(telefoneNorm, texto, 'pendente', cid).lastInsertRowid;
    return { queued: true, queueId: id };
  }

  // Resposta a quem escreveu não entra na trava: segurar atendimento para
  // "proteger o número" é o inverso do que protege — conversa respondida é
  // justamente o sinal bom para o WhatsApp. A trava é para envio ativo.
  if (!ignorarRitmo) {
    const ritmo = checarRitmo(db, cfg);
    if (!ritmo.ok) {
      const id = db.prepare(
        'INSERT INTO whatsapp_queue (telefone, texto, status, erro, canalId) VALUES (?, ?, ?, ?, ?)'
      ).run(telefoneNorm, texto, 'pendente', 'segurado: ' + ritmo.motivo, cid).lastInsertRowid;
      return { success: false, queued: true, queueId: id, segurado: true, motivo: ritmo.motivo, esperar: ritmo.esperar, canalId: cid };
    }
  }

  try {
    const result = await dispatchViaProvider(db, cfg, { telefone: telefoneNorm, texto });
    const id = db.prepare(
      'INSERT INTO whatsapp_queue (telefone, texto, status, provider, providerMessageId, dataEnvio, canalId) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)'
    ).run(telefoneNorm, texto, 'enviado', cfg.provider, result.providerMessageId || null, cid).lastInsertRowid;
    return { success: true, queueId: id, providerMessageId: result.providerMessageId, canalId: cid, instance: cfg.instance };
  } catch (err) {
    db.prepare(
      'INSERT INTO whatsapp_queue (telefone, texto, status, erro, provider, canalId) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(telefoneNorm, texto, 'erro', err.message, cfg.provider, cid);
    return { success: false, error: err.message, canalId: cid };
  }
}

async function dispatchViaProvider(db, cfg, { telefone, texto }) {
  if (cfg.provider === 'evolution') {
    const { base, apikey } = evoCreds(cfg);
    if (!base || !cfg.instance || !apikey) {
      throw new Error('Config evolution incompleta (baseUrl/instance/apikey)');
    }
    const r = await fetch(`${base}/message/sendText/${cfg.instance}`, {
      method: 'POST',
      headers: { apikey, 'content-type': 'application/json' },
      body: JSON.stringify({ number: telefone, text: texto }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status !== 200 && r.status !== 201) {
      throw new Error(`evolution http ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return { providerMessageId: data?.key?.id || null };
  }
  if (cfg.provider === 'zapi') {
    // TODO: implementar Z-API
    throw new Error('Provider zapi ainda nao implementado');
  }
  if (cfg.provider === 'meta') {
    // TODO: implementar Meta Cloud API
    throw new Error('Provider meta ainda nao implementado');
  }
  throw new Error('Provider desconhecido: ' + cfg.provider);
}

/**
 * O que a Evolution precisa saber sobre o arquivo. O `mediatype` errado faz a
 * mensagem chegar como imagem quebrada: vídeo tem de ir como 'video'.
 * Os formatos aceitos são os do conjunto do modelo (comm-imagens.js).
 */
function midiaDoCaminho(caminho) {
  const ext = require('path').extname(String(caminho || '')).toLowerCase();
  if (ext === '.mp4') return { mediatype: 'video', mimetype: 'video/mp4' };
  return { mediatype: 'image',
           mimetype: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp'
                   : ext === '.gif' ? 'image/gif' : 'image/jpeg' };
}

/**
 * Envia imagem ou vídeo com legenda, pelo número `canalId` ou pelo padrão. Sem
 * arquivo ou sem Evolution, cai no texto.
 *
 * Até 28/09 a imagem não passava pelo ritmo nem entrava na fila: campanha com
 * imagem burlava a proteção do número e não aparecia nos contadores. Agora
 * passa pela mesma trava e fica registrada como qualquer envio.
 */
async function enviarWhatsAppMidia(db, { telefone, texto, imagePath, canalId = null, ignorarRitmo = false }) {
  migrarQueue(db);
  const cfg = loadProviderConfig(db, canalId);
  let tel = String(telefone || '').replace(/\D/g, '');
  if (tel && !tel.startsWith('55')) tel = '55' + tel;
  if (!tel) return { success: false, error: 'Telefone invalido' };
  if (canalId && !cfg) return { success: false, error: 'Número de WhatsApp não encontrado ou removido' };
  if (!cfg || cfg.provider !== 'evolution' || !imagePath) return enviarWhatsApp(db, { telefone, texto, ignorarRitmo, canalId });
  const cid = cfg.canalId || null;
  if (!ignorarRitmo) {
    const ritmo = checarRitmo(db, cfg);
    if (!ritmo.ok) {
      const id = db.prepare('INSERT INTO whatsapp_queue (telefone, texto, status, erro, canalId) VALUES (?, ?, ?, ?, ?)')
        .run(tel, texto, 'pendente', 'segurado: ' + ritmo.motivo, cid).lastInsertRowid;
      return { success: false, queued: true, queueId: id, segurado: true, motivo: ritmo.motivo, esperar: ritmo.esperar, canalId: cid };
    }
  }
  try {
    const fs = require('fs'), path = require('path');
    const { base, apikey } = evoCreds(cfg);
    const { mediatype, mimetype } = midiaDoCaminho(imagePath);
    const media = fs.readFileSync(imagePath).toString('base64');
    const r = await fetch(`${base}/message/sendMedia/${cfg.instance}`, {
      method: 'POST', headers: { apikey, 'content-type': 'application/json' },
      body: JSON.stringify({ number: tel, mediatype, mimetype, media, fileName: path.basename(imagePath), caption: texto }),
    });
    const data = await r.json().catch(() => ({}));
    // Com a resposta, como no envio de texto: é ela que diz "exists": false
    // quando o número não tem WhatsApp (wa-numeros.js marca o número).
    if (r.status !== 200 && r.status !== 201) throw new Error(`evolution media http ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
    const pid = (data && data.key && data.key.id) || null;
    const id = db.prepare(`INSERT INTO whatsapp_queue (telefone, texto, status, provider, providerMessageId, dataEnvio, canalId)
      VALUES (?, ?, 'enviado', 'evolution', ?, CURRENT_TIMESTAMP, ?)`).run(tel, texto, pid, cid).lastInsertRowid;
    return { success: true, queueId: id, providerMessageId: pid, canalId: cid, instance: cfg.instance };
  } catch (e) {
    db.prepare("INSERT INTO whatsapp_queue (telefone, texto, status, erro, provider, canalId) VALUES (?, ?, 'erro', ?, 'evolution', ?)")
      .run(tel, texto, e.message, cid);
    return { success: false, error: e.message, canalId: cid };
  }
}

// Guard: só tenants com o módulo WhatsApp habilitado acessam /api/whatsapp/*.
// Flag dedicado por-tenant (config.whatsapp_enabled === '1'), independente da seção
// "comunicacao" (que está ligada em quase todos). Mesma fonte de verdade do menu. Fail-closed.
function exigirWhatsApp(db) {
  return (req, res, next) => {
    try {
      const row = db.prepare("SELECT valor FROM config WHERE chave = 'whatsapp_enabled'").get();
      if (row && String(row.valor) === '1') return next();
    } catch (_) { /* fail-closed abaixo */ }
    return res.status(403).json({ success: false, error: 'modulo_whatsapp_desabilitado' });
  };
}

function registrarRotasWhatsApp(app, db) {
  migrarQueue(db);
  const gate = exigirWhatsApp(db);

  app.get('/api/whatsapp/queue', gate, (req, res) => {
    try {
      const status = req.query.status || 'pendente';
      const rows = db.prepare(
        'SELECT id, telefone, texto, status, erro, dataCriacao, dataEnvio FROM whatsapp_queue WHERE status = ? ORDER BY id DESC LIMIT 200'
      ).all(status);
      res.json({ success: true, items: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/whatsapp/queue/:id/marcar-enviado', gate, (req, res) => {
    try {
      db.prepare('UPDATE whatsapp_queue SET status = ?, dataEnvio = CURRENT_TIMESTAMP WHERE id = ?')
        .run('enviado', req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // O número de uma chamada: ?canal=N na leitura, canalId no corpo da escrita.
  // Sem nenhum, vale o padrão.
  const canalDe = (req) => Number((req.query && req.query.canal) || (req.body && req.body.canalId)) || null;
  const semApikey = (c) => c && ({ id: c.id, nome: c.nome, instance: c.instance, padrao: c.padrao });

  app.get('/api/whatsapp/config', gate, (req, res) => {
    try {
      const cfg = loadProviderConfig(db, canalDe(req));
      // não expõe a apikey pro frontend
      const safe = cfg ? { provider: cfg.provider, instance: cfg.instance, canalId: cfg.canalId || null, apikey: cfg.apikey ? '***' : undefined }
        : { provider: null };
      res.json({ success: true, config: safe });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** Estado de uma instância na Evolution, com prazo: número fora do ar não trava a lista. */
  async function estadoDaInstancia(cfg) {
    if (!cfg || cfg.provider !== 'evolution' || !cfg.instance) return 'sem-config';
    const { base, apikey } = evoCreds(cfg);
    const ctl = new AbortController();
    const prazo = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetch(`${base}/instance/connectionState/${cfg.instance}`, { headers: { apikey }, signal: ctl.signal });
      const data = await r.json().catch(() => ({}));
      return data?.instance?.state || data?.state || (r.status === 404 ? 'inexistente' : null);
    } catch (_) { return 'sem-resposta'; }
    finally { clearTimeout(prazo); }
  }

  // Estado da conexão de um número (o padrão, sem ?canal).
  app.get('/api/whatsapp/status', gate, async (req, res) => {
    try {
      const cfg = loadProviderConfig(db, canalDe(req));
      if (!cfg || cfg.provider !== 'evolution' || !cfg.instance) {
        return res.json({ success: true, provider: cfg?.provider || null, instance: cfg?.instance || null, state: 'sem-config' });
      }
      res.json({ success: true, provider: 'evolution', instance: cfg.instance, canalId: cfg.canalId || null,
                 state: await estadoDaInstancia(cfg) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== Os números da empresa =====
  app.get('/api/whatsapp/canais', gate, async (req, res) => {
    try {
      migrarQueue(db);
      const lista = canais.listarCanais(db);
      const estados = await Promise.all(lista.map(c => estadoDaInstancia(loadProviderConfig(db, c.id))));
      res.json({ success: true, canais: lista.map((c, i) => ({ ...semApikey(c), state: estados[i] })) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Número novo. A instância na Evolution ganha nome `le_<empresa>_<n>`, e é o
   * prefixo `le_` que deixa o setWebhook apontar o recebimento para cá. O
   * primeiro número da empresa nasce padrão; os outros nascem com a IA
   * desligada, até alguém configurá-los.
   */
  app.post('/api/whatsapp/canais', gate, (req, res) => {
    try {
      migrarQueue(db);
      const slug = String(req.tenantCtx?.slug || '').replace(/[^a-z0-9-]/gi, '').toLowerCase();
      if (!slug) return res.status(400).json({ success: false, error: 'tenant nao resolvido' });
      const nome = String(req.body?.nome || '').trim().slice(0, 60);
      if (!nome) return res.status(400).json({ success: false, error: 'Dê um nome ao número (ex.: Comercial, Suporte)' });
      const existentes = canais.listarCanais(db, { incluirInativos: true });
      const usadas = new Set(existentes.map(c => c.instance));
      let instance = existentes.length ? null : 'le_' + slug;
      for (let n = existentes.length + 1; !instance || usadas.has(instance); n++) instance = `le_${slug}_${n}`;
      const padrao = canais.canalPadrao(db);
      const primeiro = !padrao;
      // O número novo nasce com a configuração do padrão (instruções da IA,
      // estilo, horário e ritmo), a pedido, em 29/09: mantém o padrão, e muda
      // quem quiser. Duas exceções. A IA nasce desligada, porque o número ainda
      // vai ser conectado e só deve responder quando alguém ligar. O teto do dia
      // não vem, porque o número novo precisa do aquecimento (40, 90, 180, 300):
      // herdar o teto de um número maduro é o caminho para ele ser bloqueado.
      const herdada = { ...((padrao && padrao.config) || {}) };
      delete herdada.whatsapp_ai_enabled;
      delete herdada.limite_dia;
      const id = db.prepare('INSERT INTO whatsapp_canais (nome, instance, padrao, config) VALUES (?, ?, ?, ?)')
        .run(nome, instance, primeiro ? 1 : 0, JSON.stringify(herdada)).lastInsertRowid;
      res.json({ success: true, canal: semApikey(canais.canalPorId(db, id)) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Renomear, ou tornar padrão (só um é padrão por vez).
  app.put('/api/whatsapp/canais/:id', gate, (req, res) => {
    try {
      const canal = canais.canalPorId(db, req.params.id);
      if (!canal) return res.status(404).json({ success: false, error: 'Número não encontrado' });
      const nome = req.body?.nome !== undefined ? String(req.body.nome).trim().slice(0, 60) : null;
      if (nome !== null && !nome) return res.status(400).json({ success: false, error: 'O nome não pode ficar vazio' });
      db.transaction(() => {
        if (nome) db.prepare('UPDATE whatsapp_canais SET nome = ? WHERE id = ?').run(nome, canal.id);
        if (req.body?.padrao === true) {
          db.prepare('UPDATE whatsapp_canais SET padrao = 0').run();
          db.prepare('UPDATE whatsapp_canais SET padrao = 1 WHERE id = ?').run(canal.id);
        }
      })();
      res.json({ success: true, canal: semApikey(canais.canalPorId(db, canal.id)) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  /**
   * Remover desconecta o aparelho e desativa o número. A linha fica, para o
   * histórico (conversas e envios) continuar dizendo por onde passou. O padrão
   * não sai: as mensagens do sistema ficariam sem número.
   */
  app.delete('/api/whatsapp/canais/:id', gate, async (req, res) => {
    try {
      const canal = canais.canalPorId(db, req.params.id);
      if (!canal) return res.status(404).json({ success: false, error: 'Número não encontrado' });
      if (canal.padrao) return res.status(400).json({ success: false, error: 'Este é o número padrão. Torne outro padrão antes de removê-lo' });
      const { base, apikey } = evoCreds(canal);
      if (base && apikey) {
        await fetch(`${base}/instance/logout/${canal.instance}`, { method: 'DELETE', headers: { apikey } }).catch(() => {});
      }
      db.prepare('UPDATE whatsapp_canais SET ativo = 0, padrao = 0 WHERE id = ?').run(canal.id);
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Quanto já saiu e quanto ainda cabe, por número. Sem isto, "não enviou"
  // vira mistério — e o operador tenta de novo, que é o que queima o número.
  app.get('/api/whatsapp/ritmo', gate, (req, res) => {
    try {
      migrarQueue(db);
      const cfg = loadProviderConfig(db, canalDe(req));
      const filtro = cfg && cfg.canalId ? ` AND canalId = ${Number(cfg.canalId)}` : '';
      const q = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
      const hora = q(`SELECT COUNT(*) n FROM whatsapp_queue WHERE status='enviado' AND dataEnvio >= datetime('now','-1 hour')${filtro}`);
      const dia = q(`SELECT COUNT(*) n FROM whatsapp_queue WHERE status='enviado' AND date(dataEnvio, '-3 hours') = date('now', '-3 hours')${filtro}`);
      const segurados = q(`SELECT COUNT(*) n FROM whatsapp_queue WHERE status='pendente' AND erro LIKE 'segurado:%'${filtro}`);
      const primeiro = db.prepare(`SELECT MIN(dataEnvio) d FROM whatsapp_queue WHERE status='enviado'${filtro}`).get().d;
      const dias = primeiro
        ? db.prepare("SELECT CAST(julianday('now') - julianday(?) AS INTEGER) d").get(primeiro).d
        : null;
      const ritmo = checarRitmo(db, cfg);
      // Os três tetos que valem hoje para o número, configurados ou padrão.
      // `padrao` é o que vale com o campo em branco (o do dia, pela idade do número).
      let limiteDia = null, diaPadrao = null;
      try { limiteDia = tetoDoDia(db, cfg, filtro); diaPadrao = tetoDoDia(db, {}, filtro); } catch (_) { /* fila antiga */ }
      res.json({ success: true, hora, dia, segurados, diasDeUso: dias,
                 limiteHora: numeroCfg(cfg, 'limite_hora', LIMITE_HORA_PADRAO),
                 intervaloMinS: numeroCfg(cfg, 'intervalo_min_s', INTERVALO_MIN_S), limiteDia,
                 padrao: { limiteHora: LIMITE_HORA_PADRAO, intervaloMinS: INTERVALO_MIN_S, limiteDia: diaPadrao },
                 podeEnviarAgora: ritmo.ok, motivo: ritmo.motivo || null });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Envio de mensagem de teste (PoC) — usa o mesmo enviarWhatsApp gravando na whatsapp_queue.
  app.post('/api/whatsapp/test', gate, async (req, res) => {
    try {
      const { telefone, texto } = req.body || {};
      if (!telefone || !texto) return res.status(400).json({ success: false, error: 'telefone e texto obrigatorios' });
      const result = await enviarWhatsApp(db, { telefone, texto, canalId: canalDe(req) });
      res.json({ success: !result.error, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Pareamento de um número: garante a instância na Evolution e devolve o QR.
   * Sem número nenhum cadastrado, cria o primeiro (padrão), como a conexão
   * única de antes fazia.
   */
  app.post('/api/whatsapp/connect', gate, async (req, res) => {
    try {
      migrarQueue(db);
      const slug = req.tenantCtx?.slug;
      if (!slug) return res.status(400).json({ success: false, error: 'tenant nao resolvido' });
      let canal = canais.canalOuPadrao(db, canalDe(req));
      if (!canal && canalDe(req)) return res.status(404).json({ success: false, error: 'Número não encontrado' });
      if (!canal) {
        const antigo = loadProviderConfig(db);
        const instance = (antigo && antigo.instance) || ('le_' + String(slug).replace(/[^a-z0-9-]/gi, '').toLowerCase());
        const id = db.prepare("INSERT INTO whatsapp_canais (nome, instance, padrao, config) VALUES ('Principal', ?, 1, '{}')")
          .run(instance).lastInsertRowid;
        canal = canais.canalPorId(db, id);
      }
      const instance = canal.instance;
      const { base, apikey } = evoCreds(canal);
      if (!base || !apikey) return res.status(500).json({ success: false, error: 'EVOLUTION_URL/APIKEY nao configurados' });

      // já existe? qual estado?
      let state = null, exists = false;
      const st = await fetch(`${base}/instance/connectionState/${instance}`, { headers: { apikey } });
      if (st.status === 200) { exists = true; const d = await st.json().catch(() => ({})); state = d?.instance?.state || d?.state || null; }

      await setWebhook(base, apikey, instance); // recebimento -> liciteagora (só le_*)

      if (state === 'open') return res.json({ success: true, connected: true, instance, canalId: canal.id });

      let qr = null;
      if (exists) {
        const c = await fetch(`${base}/instance/connect/${instance}`, { headers: { apikey } });
        qr = (await c.json().catch(() => ({})))?.base64 || null;
      } else {
        const c = await fetch(`${base}/instance/create`, {
          method: 'POST', headers: { apikey, 'content-type': 'application/json' },
          body: JSON.stringify({ instanceName: instance, integration: 'WHATSAPP-BAILEYS', qrcode: true }),
        });
        const d = await c.json().catch(() => ({}));
        if (c.status !== 200 && c.status !== 201) throw new Error(`create http ${c.status}: ${JSON.stringify(d).slice(0, 160)}`);
        qr = d?.qrcode?.base64 || null;
        await setWebhook(base, apikey, instance);   // a instância acabou de nascer
      }
      res.json({ success: true, connected: false, instance, canalId: canal.id, qr });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Desconecta (logout) um número; mantém o nome pra reconectar depois.
  app.post('/api/whatsapp/disconnect', gate, async (req, res) => {
    try {
      const cfg = loadProviderConfig(db, canalDe(req));
      if (!cfg || !cfg.instance) return res.json({ success: true });
      const { base, apikey } = evoCreds(cfg);
      await fetch(`${base}/instance/logout/${cfg.instance}`, { method: 'DELETE', headers: { apikey } }).catch(() => {});
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Inbox: conversas (agrupadas por remote_jid).
  app.get('/api/whatsapp/conversations', gate, (req, res) => {
    try {
      migrarQueue(db);
      const rows = db.prepare(`
        SELECT remote_jid AS jid,
               COUNT(*) AS total,
               MAX(id) AS lastId,
               (SELECT texto FROM whatsapp_messages x WHERE x.remote_jid = m.remote_jid ORDER BY id DESC LIMIT 1) AS ultimo,
               (SELECT push_name FROM whatsapp_messages x WHERE x.remote_jid = m.remote_jid AND push_name IS NOT NULL ORDER BY id DESC LIMIT 1) AS nome,
               (SELECT timestamp FROM whatsapp_messages x WHERE x.remote_jid = m.remote_jid ORDER BY id DESC LIMIT 1) AS ts
        FROM whatsapp_messages m
        GROUP BY remote_jid
        ORDER BY lastId DESC
        LIMIT 100
      `).all();
      res.json({ success: true, conversas: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Inbox: mensagens de uma conversa.
  app.get('/api/whatsapp/messages', gate, (req, res) => {
    try {
      migrarQueue(db);
      const jid = String(req.query.jid || '');
      if (!jid) return res.status(400).json({ success: false, error: 'jid obrigatorio' });
      const rows = db.prepare(
        'SELECT id, from_me, push_name, texto, message_type, timestamp FROM whatsapp_messages WHERE remote_jid = ? ORDER BY id ASC LIMIT 500'
      ).all(jid);
      res.json({ success: true, mensagens: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Inbox: responder numa conversa (envia + grava o outgoing; echo do webhook deduplica).
  app.post('/api/whatsapp/send', gate, async (req, res) => {
    try {
      const { jid, texto } = req.body || {};
      if (!jid || !texto) return res.status(400).json({ success: false, error: 'jid e texto obrigatorios' });
      const telefone = String(jid).split('@')[0];
      // Atendente respondendo no inbox: é conversa em andamento, não disparo.
      const result = await enviarWhatsApp(db, { telefone, texto, ignorarRitmo: true, canalId: canalDe(req) });
      if (result.error) return res.json({ success: false, error: result.error });
      try {
        migrarQueue(db);
        db.prepare('INSERT OR IGNORE INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, texto, timestamp) VALUES (?,?,?,?,?,?)')
          .run(result.providerMessageId || null, result.instance || null, jid, 1, texto, Math.floor(Date.now() / 1000));
      } catch (_) {}
      res.json({ success: true, providerMessageId: result.providerMessageId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Atendente de IA, horário e ritmo de UM número (?canal=N; sem ele, o
   * padrão). O pop-up de mensagem nova continua sendo da empresa.
   */
  app.get('/api/whatsapp/ai-config', gate, (req, res) => {
    try {
      migrarQueue(db);
      const canal = canais.canalOuPadrao(db, canalDe(req));
      if (!canal && canalDe(req)) return res.status(404).json({ success: false, error: 'Número não encontrado' });
      const get = configDoAtendimento(db, canal && canal.id);
      // kbLegado: só para conferência de quem migrou. Não entra mais no prompt
      // — o conhecimento vem de ia_base (tela Conversas → Base da IA).
      const kb = db.prepare("SELECT valor FROM config WHERE chave = 'whatsapp_ai_kb'").get();
      const hor = require('./atendimento-horario').lerHorario(get);
      const popup = db.prepare("SELECT valor FROM config WHERE chave = 'whatsapp_popup_ativo'").get();
      // O catálogo viaja junto das escolhas: a tela desenha os botões a partir
      // dele, e assim opção nova aparece sem ninguém editar o HTML.
      const escolhas = lerEstilo(get);
      const num = (k) => { const n = Number(get(k)); return Number.isFinite(n) && n > 0 ? n : null; };
      res.json({ success: true, canal: semApikey(canal), enabled: get('whatsapp_ai_enabled') === '1',
                 prompt: get('whatsapp_ai_prompt') || '',
                 escopo: get('whatsapp_ai_escopo') === 'campanha' ? 'campanha' : 'todos',
                 horario: hor,
                 ritmo: { limiteHora: num('limite_hora'), intervaloMinS: num('intervalo_min_s'), limiteDia: num('limite_dia'),
                          padrao: { limiteHora: LIMITE_HORA_PADRAO, intervaloMinS: INTERVALO_MIN_S, limiteDiaMax: LIMITE_DIARIO_MAX } },
                 popupAtivo: popup?.valor === '1',
                 estilo: { catalogo: ESTILO, escolhas },
                 kbLegado: kb?.valor || '', kbLegadoEmUso: false });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
  app.post('/api/whatsapp/ai-config', gate, (req, res) => {
    try {
      migrarQueue(db);
      const { enabled, prompt, kb, escopo, horario, popupAtivo, estilo, ritmo } = req.body || {};
      const canal = canais.canalOuPadrao(db, canalDe(req));
      if (!canal && canalDe(req)) return res.status(404).json({ success: false, error: 'Número não encontrado' });
      // O que é do número vai para ele; sem número cadastrado, para a empresa,
      // como antes de haver vários (configDoAtendimento lê do mesmo lugar).
      const mudancas = {};
      const doCanal = canal ? { run: (k, v) => { mudancas[k] = v; } } : null;
      const daEmpresa = db.prepare("INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)");
      const up = doCanal || daEmpresa;
      if (enabled !== undefined) up.run('whatsapp_ai_enabled', enabled ? '1' : '0');

      // Tom e limites. Recusa id que não existe no catálogo em vez de gravar:
      // escolha inventada não vira frase nenhuma, e o prompt sairia mais fraco
      // do que a tela mostra, sem ninguém notar.
      if (estilo && typeof estilo === 'object') {
        for (const [grupo, def] of Object.entries(ESTILO)) {
          if (!(grupo in estilo)) continue;
          const valido = new Set(def.opcoes.map(o => o.id));
          if (def.escolha === 'varias') {
            const lista = Array.isArray(estilo[grupo]) ? estilo[grupo].map(String) : [];
            const fora = lista.filter(id => !valido.has(id));
            if (fora.length) return res.status(400).json({ success: false,
              error: `Opção desconhecida em ${def.rotulo}: ${fora.join(', ')}` });
            up.run(def.chave, JSON.stringify(lista));
          } else {
            const id = estilo[grupo] == null ? '' : String(estilo[grupo]);
            if (id && !valido.has(id)) return res.status(400).json({ success: false,
              error: `Opção desconhecida em ${def.rotulo}: ${id}` });
            up.run(def.chave, id);
          }
        }
      }
      if (typeof prompt === 'string') up.run('whatsapp_ai_prompt', prompt.slice(0, 8000));
      // Só grava o escopo se ele veio: a tela antiga (whatsapp.html) salva sem
      // esse campo, e um default aqui apagaria a escolha feita na tela nova.
      if (escopo === 'campanha' || escopo === 'todos') up.run('whatsapp_ai_escopo', escopo);

      // Pop-up de mensagem nova. Chave da EMPRESA: decide se o sistema avisa
      // alguém. Quem recebe em qual aparelho é outra coisa, e mora em
      // `push_inscricoes` — desligar aqui cala todo mundo de uma vez, sem
      // precisar mexer em inscrição nenhuma.
      if (popupAtivo !== undefined) daEmpresa.run('whatsapp_popup_ativo', popupAtivo ? '1' : '0');

      // Horário de atendimento. Só grava quando veio, pela mesma razão do
      // escopo: a tela antiga salva sem este campo e apagaria a agenda inteira.
      //
      // A faixa é VALIDADA aqui, e não só na tela: uma hora inválida gravada
      // faria a porta do webhook devolver "fora do expediente" para sempre, e o
      // atendimento cairia calado, sem erro em log nenhum.
      if (horario && typeof horario === 'object') {
        const { DIAS, minutos } = require('./atendimento-horario');
        const faixas = {};
        for (const d of DIAS) {
          const f = horario.faixas && horario.faixas[d];
          if (!Array.isArray(f)) { faixas[d] = null; continue; }   // dia fechado
          const de = minutos(f[0]), ate = minutos(f[1]);
          if (de === null || ate === null) {
            return res.status(400).json({ success: false,
              error: `Horário inválido em ${d}: use HH:MM (veio "${f[0]}" e "${f[1]}")` });
          }
          if (de === ate) {
            return res.status(400).json({ success: false,
              error: `Em ${d}, início e fim são iguais — para fechar o dia, desmarque-o` });
          }
          faixas[d] = [f[0], f[1]];
        }
        up.run('whatsapp_horario_ativo', horario.ativo ? '1' : '0');
        up.run('whatsapp_horario_faixas', JSON.stringify(faixas));
        up.run('whatsapp_horario_msg', String(horario.mensagem || '').slice(0, 600));
      }
      // Ritmo do número: vazio volta ao padrão do sistema. Número inválido é
      // recusado, e não gravado: um zero aqui travaria todo envio do número.
      if (ritmo && typeof ritmo === 'object') {
        const limites = { limiteHora: ['limite_hora', 200], intervaloMinS: ['intervalo_min_s', 3600], limiteDia: ['limite_dia', 2000] };
        for (const [campo, [chave, max]] of Object.entries(limites)) {
          if (!(campo in ritmo)) continue;
          const v = ritmo[campo];
          if (v === null || v === '') { up.run(chave, ''); continue; }
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > max) {
            return res.status(400).json({ success: false, error: `Ritmo inválido em ${campo}: use um número inteiro de 1 a ${max}` });
          }
          up.run(chave, String(n));
        }
      }
      // `kb` deixou de ser aceito: gravar num campo que ninguém lê é pior que
      // recusar — quem enviasse acharia que a IA aprendeu algo.
      if (typeof kb === 'string') {
        return res.status(400).json({ success: false,
          error: 'Conhecimento agora é item da Base da IA (Conversas → Base da IA), não este campo' });
      }
      if (canal) canais.salvarConfigCanal(db, canal.id, mudancas);
      else if (ritmo) return res.status(400).json({ success: false, error: 'Conecte um número antes de ajustar o ritmo' });
      res.json({ success: true, canalId: canal ? canal.id : null });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Simular atendimento IA — mesmo pipeline do autoResponder (prompt + KB + histórico
  // + chamarChatLLM), sem enviar nem gravar.
  app.post('/api/whatsapp/sim-atendimento', gate, async (req, res) => {
    try {
      const raw = Array.isArray(req.body && req.body.history) ? req.body.history : [];
      const history = raw
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
      if (!history.length) return res.status(400).json({ success: false, error: 'history vazio' });
      const { createConfigHelpers } = require('./config-helpers');
      const { chamarChatLLM } = require('./chat-ia');
      const keys = createConfigHelpers(db).getIAKeys();
      if (!keys) return res.json({ success: false, error: 'tenant sem chave de IA configurada' });
      // MESMA função do atendimento real (buildSystemAtendimento) → simulação idêntica.
      const campId = req.body && req.body.campanha_id;
      const prompt = buildSystemAtendimento(db, campId, { canalId: canalDe(req) });
      let reply = '', provider;
      try {
        const out = await chamarChatLLM([{ role: 'system', content: prompt }, ...history], keys, require('./ia-modelos').resolverModelos(db));
        reply = ((out && out.content) || '').trim(); provider = out && out.provider;
      } catch (_) { /* garantia 1: nunca silêncio → cai no fallback abaixo */ }
      if (!reply) reply = FALLBACK_SEM_RESPOSTA;
      res.json({ success: true, reply, provider, contexto: campId ? 'campanha' : 'tenant' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[WhatsApp] Rotas registradas (modo: ' + (loadProviderConfig(db)?.provider || 'fila') + ')');
}

module.exports = { enviarWhatsApp, enviarWhatsAppMidia, midiaDoCaminho, migrarQueue, loadProviderConfig, configDoAtendimento, registrarRotasWhatsApp, buildSystemAtendimento, FALLBACK_SEM_RESPOSTA, checarRitmo, ESTILO, lerEstilo, frasesDeEstilo, blocoRoteiro };
