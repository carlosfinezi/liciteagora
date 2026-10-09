/**
 * whatsapp-webhook.js — recebimento (inbox) + auto-resposta IA, multi-tenant.
 *
 * Rota PÚBLICA (server-to-server) chamada pelo Evolution quando chega mensagem.
 * Mapeia instance -> tenant pela convenção 'le_<slug>', grava em whatsapp_messages
 * e (se o tenant habilitou) responde via IA reusando a chain de providers do
 * chat-ia.js com as chaves do próprio tenant. Registrada em server.js ANTES da
 * barreira de auth; path liberado no bypass do tenant-middleware.
 */
const { migrarQueue, enviarWhatsApp, configDoAtendimento } = require('./whatsapp-adapter');
const canais = require('./whatsapp-canais');

const OPT_OUT_RE = /^\s*(parar|sair|stop|cancelar|descadastrar|remover)\b/i;

/**
 * A plataforma do canal que recebeu, que é o `canal` da conversa.
 *
 * O atendimento inteiro desta tela (ligar e desligar a IA na conversa, a pausa
 * de 4 h, o roteiro) acha a conversa por `jid + canal + canalId`. Com
 * 'whatsapp' escrito fixo, o Messenger não achava a sua própria conversa: a IA
 * não podia ser desligada ali, a pausa não valia e o roteiro nunca começava.
 *
 * Sem canal (tenant anterior à migração de números) é WhatsApp, como era.
 */
const plataformaDo = (canal) => (canal && canal.plataforma) || 'whatsapp';
const AI_MAX_PER_HOUR = 15;
const HIST_TURNS = 10;
const PAUSE_MANUAL_S = 4 * 3600;
const PROMPT_PADRAO = 'Você é o atendente virtual desta empresa no WhatsApp. Responda em português, de forma breve, cordial e objetiva. Se não souber algo, diga que vai encaminhar para um atendente humano. Nunca peça senha ou dado bancário.';

// Devolve o jid pelo qual a conversa deve ser conhecida em todo o sistema.
//
// O WhatsApp migrou o endereçamento 1:1 para LID ('<numero>@lid') a partir de
// 2026-05, e desde junho é quase todo o tráfego. O número real viaja em
// key.remoteJidAlt. Sem normalizar aqui, o filtro '@s.whatsapp.net' lá embaixo
// descartaria a mensagem, e o telefone que o autoResponder extrai do jid seria
// o LID — a resposta sairia para um número que não existe.
function jidCanonico(key) {
  if (!key) return null;
  const alt = key.remoteJidAlt;
  if (typeof alt === 'string' && alt.endsWith('@s.whatsapp.net')) return alt;
  return key.remoteJid || null;
}

// O texto de uma mensagem, nos formatos que chegam. Até 29/09 só o texto
// simples e a legenda de imagem e vídeo contavam, e ficavam vazias a mensagem
// de empresa do WhatsApp Business (templateMessage, com a legenda dentro de
// hydratedTemplate), a legenda de documento, a resposta de botão ou lista e a
// mensagem temporária ou de visualização única, que embrulham outra mensagem.
function extractText(msg) {
  if (!msg) return null;
  const embrulhada = (msg.ephemeralMessage || msg.viewOnceMessage || msg.viewOnceMessageV2
    || msg.documentWithCaptionMessage || msg.editedMessage || {}).message;
  if (embrulhada) return extractText(embrulhada);
  const tpl = msg.templateMessage && (msg.templateMessage.hydratedTemplate || msg.templateMessage.hydratedFourRowTemplate);
  // O formato NOVO da mensagem de empresa, com botões nativos: o texto não está
  // em `hydratedTemplate`, e sim em `interactiveMessageTemplate.body.text`, com
  // o título em `header.title`. Medido na Evolution em 06/10/2026: das 50
  // mensagens de empresa mais recentes do 1bit, 10 vinham assim, e as 10
  // ficaram gravadas sem texto nenhum — entre elas o aviso de login da Meta.
  const inter = msg.templateMessage && msg.templateMessage.interactiveMessageTemplate;
  const legenda = (m) => m && (m.caption || null);
  return msg.conversation
    || (msg.extendedTextMessage && msg.extendedTextMessage.text)
    || legenda(msg.imageMessage) || legenda(msg.videoMessage) || legenda(msg.documentMessage)
    || (tpl && (tpl.hydratedContentText || legenda(tpl.imageMessage) || legenda(tpl.videoMessage)
      || legenda(tpl.documentMessage)))
    || (inter && ((inter.body && inter.body.text) || (inter.header && inter.header.title)
      || legenda(inter.header && inter.header.imageMessage)))
    || (msg.buttonsResponseMessage && msg.buttonsResponseMessage.selectedDisplayText)
    || (msg.templateButtonReplyMessage && msg.templateButtonReplyMessage.selectedDisplayText)
    || (msg.listResponseMessage && (msg.listResponseMessage.title
      || (msg.listResponseMessage.singleSelectReply && msg.listResponseMessage.singleSelectReply.selectedRowId)))
    || null;
}

/**
 * A REAÇÃO (o emoji que o contato cola numa mensagem) não é uma mensagem da
 * conversa: ela pertence à mensagem reagida.
 *
 * Até 02/10/2026 ela era gravada com texto vazio e sem referência, e virava um
 * balão "(sem texto)" no meio da conversa — 44 deles no 1bit em 30 dias. Agora
 * o emoji vai no `texto` e o id da mensagem reagida no `citaWaId`, que é a mesma
 * coluna da citação: nos dois casos ela guarda "a mensagem a que esta se
 * refere". A tela mostra o emoji no balão reagido e não desenha balão para a
 * reação.
 *
 * Reação RETIRADA chega com `text` vazio, e é isso que apaga o emoji de lá.
 */
function daReacao(msg) {
  const r = msg && msg.reactionMessage;
  if (!r) return null;
  return { emoji: String(r.text || ''), alvo: (r.key && r.key.id) ? String(r.key.id) : null };
}

/**
 * O id da mensagem que ESTA mensagem cita, quando ela é uma resposta.
 *
 * O WhatsApp põe isso no `contextInfo.stanzaId`, dentro do tipo da mensagem
 * (`extendedTextMessage` no texto, mas também na legenda de imagem, de vídeo e
 * de documento), e não num lugar fixo — por isso a varredura de um nível, com a
 * mesma recursão do `extractText` para as mensagens embrulhadas. Guardar isto é
 * o que deixa a tela desenhar o balão citado em cima da resposta; sem ele, a
 * resposta do contato chega como mensagem solta e perde a referência.
 */
function idCitado(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const embrulhada = (msg.ephemeralMessage || msg.viewOnceMessage || msg.viewOnceMessageV2
    || msg.documentWithCaptionMessage || msg.editedMessage || {}).message;
  if (embrulhada) return idCitado(embrulhada);
  for (const v of Object.values(msg)) {
    const id = v && typeof v === 'object' && v.contextInfo && v.contextInfo.stanzaId;
    if (id) return String(id);
  }
  return null;
}

// Resolve o tenant pela instância que veio no evento.
//
// A convenção 'le_<slug>' cobre as instâncias criadas pelo próprio sistema, e
// desde 28/09 também os números extras, 'le_<slug>_<n>' (whatsapp-canais.js).
// O slug nunca tem '_' (o /connect e o /canais tiram tudo que não é letra,
// dígito ou hífen), então a empresa é o trecho entre 'le_' e o próximo '_'.
// Instância criada à mão fora dele (o caso do 'status1bit') nunca casava, e o
// webhook descartava a mensagem em silêncio — motivo de o inbox estar vazio.
// Agora, quando o prefixo não bate, procura qual tenant declarou essa
// instância em whatsapp_config.
const _cacheInstancia = new Map();   // instance -> { slug, em }
const CACHE_MS = 5 * 60 * 1000;

function slugFromInstance(instance, tenantManager = null) {
  if (typeof instance !== 'string' || !instance) return null;
  if (instance.startsWith('le_')) return instance.slice(3).split('_')[0];
  if (!tenantManager) return null;

  const cache = _cacheInstancia.get(instance);
  if (cache && Date.now() - cache.em < CACHE_MS) return cache.slug;

  let achado = null;
  for (const t of tenantManager.listAll()) {
    try {
      const tdb = tenantManager.getDb(t.slug);
      if (canais.canalPorInstance(tdb, instance)) { achado = t.slug; break; }
      const v = tdb.prepare("SELECT value FROM whatsapp_config WHERE key = 'instance'").get();
      if (v && v.value === instance) { achado = t.slug; break; }
    } catch { /* tenant sem o módulo */ }
  }
  _cacheInstancia.set(instance, { slug: achado, em: Date.now() });
  return achado;
}

/**
 * Gera e envia a resposta da IA. Roda após o 200 do webhook (fire-and-forget).
 *
 * Tudo aqui é do NÚMERO que recebeu (`canal`): liga/desliga, escopo, horário,
 * instruções e tom. A resposta sai pelo mesmo número, e o limite por hora, a
 * pausa de quando um humano respondeu e o histórico contam só aquele número:
 * a mesma pessoa falando com o comercial e com o suporte são duas conversas.
 * A Base da IA é a da empresa.
 */
async function autoResponder(tdb, canal, instance, jid, incomingText, { fechouAgora = null } = {}) {
  const { createConfigHelpers } = require('./config-helpers');
  const { chamarChatLLM } = require('./chat-ia');
  const { getIAKeys } = createConfigHelpers(tdb);
  const canalId = canal ? canal.id : null;
  const getConfigValue = configDoAtendimento(tdb, canalId);
  if (getConfigValue('whatsapp_ai_enabled') !== '1') return;
  if (OPT_OUT_RE.test(incomingText)) return;
  const keys = getIAKeys();
  if (!keys) return;

  const now = Math.floor(Date.now() / 1000);
  const doNumero = 'remote_jid = ? AND COALESCE(instance, ?) = ?';
  const cnt = tdb.prepare(`SELECT COUNT(*) AS n FROM whatsapp_messages WHERE ${doNumero} AND from_bot = 1 AND timestamp >= ?`)
    .get(jid, instance, instance, now - 3600).n;
  if (cnt >= AI_MAX_PER_HOUR) return; // rate limit
  // Desligar a IA numa conversa é decisão do atendente na tela e não expira
  // em 4h como a regra acima: quando ele desliga, é porque assumiu de vez.
  let conversa = null;
  try {
    conversa = tdb.prepare('SELECT id, iaAtiva FROM conv_conversas WHERE jid = ? AND canal = ? AND canalId = ?')
      .get(jid, plataformaDo(canal), canalId || 0);
    if (conversa && !conversa.iaAtiva) return;
  } catch { /* tenant sem a central ainda */ }

  // A pausa por atendimento humano, e o "Retomar a IA" que a anula. A consulta
  // da pausa mora em conversas-routes, uma só, para a tela mostrar exatamente a
  // regra que o envio aplica (e não uma segunda verdade parecida).
  if (require('./conversas-routes').pausaDaIA(tdb, {
    jid, instance, canalId, conversaId: conversa ? conversa.id : null,
  }).pausada) return;

  // Campanha do lead (pelo número) → system prompt via a MESMA função do simulador
  // (whatsapp-adapter.buildSystemAtendimento) — garante simulação idêntica ao real.
  //
  // Só conta destinatário que JÁ RECEBEU o disparo (enviado_em preenchido): a
  // lista de uma campanha carrega dezenas de milhares de pendentes, e estar
  // numa fila de envio não é ter sido abordado.
  // As DUAS origens, pela mesma função que o roteiro de qualificação usa
  // (roteiro-conversa.campanhaDaConversa). Até 30/09 aqui só se olhava
  // `wa_campanha_dest`, a campanha legado: com o escopo em 'campanha', a IA
  // nunca respondia a quem veio de campanha NOVA, que grava em `comm_envios`.
  // Foi o que fez todos os testes de campanha do 1bit ficarem sem resposta.
  let campanha = null;
  try {
    // O `canalId` não é detalhe: sem ele a campanha de QUALQUER número do
    // tenant casaria, e o escopo 'campanha' deixaria de ser deste número.
    campanha = require('./roteiro-conversa').campanhaDaConversa(tdb, {
      id: conversa && conversa.id, jid, telefone: jid.split('@')[0], canalId,
    });
  } catch (_) { /* tenant sem campanhas */ }
  // Só o id LEGADO vai para o prompt: `buildSystemAtendimento` procura o id em
  // `wa_campanhas`, e o id de uma campanha nova acharia lá outra campanha com o
  // mesmo número. O contexto da campanha nova chega pelo roteiro (conversaId).
  const campanhaId = campanha && campanha.origem === 'wa' ? campanha.id : null;

  // Escopo do atendente: 'campanha' faz a IA responder só a quem ela mesma
  // abordou. Quem chegou por fora (indicação, site, cliente antigo) fica para o
  // humano — sem resposta automática nenhuma.
  //
  // A porta vale só para o WhatsApp. No Messenger e no Instagram não existe
  // disparo para lista, então `campanha` é SEMPRE null ali: o escopo
  // 'campanha', herdado na criação do canal ou gravado à mão, deixaria o canal
  // mudo para sempre, sem nada na tela dizendo por quê.
  if (getConfigValue('whatsapp_ai_escopo') === 'campanha' && !campanha
      && plataformaDo(canal) === 'whatsapp') return;

  // ---------- horário de atendimento ----------
  //
  // Esta porta vem DEPOIS do escopo, e a ordem é a regra inteira: quem o escopo
  // já excluía continua sem receber nada. Se o aviso de "estamos fechados"
  // viesse antes, ele alcançaria justamente quem a empresa decidiu não abordar
  // por resposta automática — o escopo deixaria de valer de madrugada.
  const fora = require('./atendimento-horario').foraDoExpediente(getConfigValue);
  if (fora) {
    // Sem mensagem configurada, a IA apenas cala: mandar um texto genérico que
    // ninguém escreveu é pior que o silêncio.
    if (!fora.mensagem) return;
    // Uma vez a cada 8 horas por conversa. Sem isto, cada mensagem da madrugada
    // devolveria o mesmo aviso, e quem escreve três vezes recebe três avisos
    // iguais — que é como um atendimento automático perde a credibilidade.
    const jaAvisou = tdb.prepare(`SELECT 1 FROM whatsapp_messages
      WHERE ${doNumero} AND from_bot = 1 AND texto = ? AND timestamp >= ? LIMIT 1`)
      .get(jid, instance, instance, fora.mensagem, now - 8 * 3600);
    if (jaAvisou) return;
    const env = await enviarWhatsApp(tdb, { telefone: jid.split('@')[0], texto: fora.mensagem, ignorarRitmo: true, canalId });
    // Mesma razão do `entregar`: aviso que não saiu não entra no histórico, ou
    // o anti-repetição de 8 h acima o daria por dito e calaria da próxima vez.
    if (env && env.foraDaJanela) return;
    try {
      tdb.prepare(`INSERT INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, from_bot, texto, timestamp)
        VALUES (?, ?, ?, 1, 1, ?, ?)
        ON CONFLICT(wa_message_id, instance) WHERE wa_message_id IS NOT NULL DO UPDATE SET from_bot = 1`)
        .run((env && env.providerMessageId) || null, instance, jid, fora.mensagem, Math.floor(Date.now() / 1000));
    } catch (_) {}
    return;
  }

  const hist = tdb.prepare(`SELECT from_me, texto FROM whatsapp_messages WHERE ${doNumero}
    AND texto IS NOT NULL AND texto <> '' ORDER BY id DESC LIMIT ?`).all(jid, instance, instance, HIST_TURNS).reverse();
  // A conversa entra para o prompt saber o que o roteiro de qualificação já
  // apurou — sem ela, a IA reperguntaria o que o contato acabou de responder.
  const conversaId = conversa ? conversa.id : null;

  // Envia e marca a mensagem como nossa. É uma função porque o desvio do roteiro
  // logo abaixo sai pelo mesmo caminho da resposta da IA: mesma gravação, mesma
  // marca de `from_bot`, mesmo tratamento do eco da Evolution.
  const entregar = async (texto) => {
    const r = await enviarWhatsApp(tdb, { telefone: jid.split('@')[0], texto, ignorarRitmo: true, canalId });
    // Canal da Meta com a janela de 24 h vencida: a mensagem NÃO saiu, e
    // gravá-la aqui a mostraria na tela como se tivesse saído — o atendente
    // leria uma resposta que o contato nunca recebeu e consideraria a conversa
    // tratada. A conversa já está em não lidas desde a mensagem que chegou, e é
    // dali que uma pessoa a pega.
    if (r && r.foraDaJanela) {
      console.log(`[autoResponder] ${jid}: fora da janela de 24h, nada enviado`);
      return;
    }
    try {
      // A Evolution devolve esta mesma mensagem pelo webhook como eco, e lá ela
      // entra com from_bot=0. Os dois caminhos disputam o mesmo wa_message_id:
      // com INSERT OR IGNORE, quem chegasse primeiro venceria, e a resposta da
      // IA nasceria sem marca — sem marca não há botão de corrigir na tela.
      // O upsert faz a marca vencer sempre, tenha o eco chegado antes ou não.
      tdb.prepare(`INSERT INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, from_bot, texto, timestamp)
        VALUES (?, ?, ?, 1, 1, ?, ?)
        ON CONFLICT(wa_message_id, instance) WHERE wa_message_id IS NOT NULL DO UPDATE SET from_bot = 1`)
        .run((r && r.providerMessageId) || null, instance, jid, texto, Math.floor(Date.now() / 1000));
    } catch (_) {}
  };

  const RC = require('./roteiro-conversa');
  const fichaConversa = () => {
    try { return tdb.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(conversaId); }
    catch (_) { return { id: conversaId, jid, telefone: jid.split('@')[0], canalId }; }
  };

  // O ROTEIRO FECHOU nesta mensagem: a mensagem de término sai literal, e não
  // há chamada de IA. `fechouAgora` vem do `qualificarPeloRoteiro`, que rodou
  // antes — depois de gravado, o estado não diz mais que acabou de fechar.
  //
  // Qualificado e desqualificado são desfechos diferentes: o primeiro promete
  // que alguém vem, e por isso pausa a IA e avisa; o segundo é despedida.
  if (conversaId && fechouAgora) {
    const msg = RC.mensagemDeTermino(tdb, fichaConversa(), fechouAgora);
    if (msg) {
      await entregar(msg);
      if (fechouAgora === 'qualificado') {
        require('./conversas-routes').pausarIA(tdb, fichaConversa(),
          { motivo: 'o roteiro terminou e o contato está esperando atendimento' });
      }
      return;
    }
  }

  // Desvio do atendimento: pediu uma pessoa, ou pediu o material. A redação vem
  // do NÚMERO (Canal), e não do modelo, e por isso nem chega a haver chamada de
  // IA aqui.
  //
  // Vem DEPOIS de todas as guardas acima de propósito. Antes delas, o desvio
  // responderia em conversa com a IA desligada à mão, fora do expediente, fora do
  // escopo de campanha e durante a pausa por atendimento humano — justamente onde
  // o sistema hoje cala.
  if (conversaId) {
    const desvio = RC.desvioDaMensagem(tdb, { id: conversaId, jid, telefone: jid.split('@')[0], canalId }, incomingText);
    if (desvio) {
      await entregar(desvio.texto);
      // Quem pediu uma pessoa não pode receber a pergunta seguinte do roteiro: a
      // mensagem viraria mentira no minuto seguinte. A pausa tem contador de 4 h
      // e o "Retomar" a anula, ao contrário do desligamento, que fica até alguém
      // religar à mão.
      if (desvio.pausarIA) {
        require('./conversas-routes').pausarIA(tdb, fichaConversa(),
          { motivo: 'o contato pediu para falar com uma pessoa' });
      }
      return;
    }
  }

  const prompt = require('./whatsapp-adapter').buildSystemAtendimento(tdb, campanhaId, { conversaId, canalId });
  const messages = [{ role: 'system', content: prompt }, ...hist.map(m => ({ role: m.from_me ? 'assistant' : 'user', content: m.texto }))];

  // Garantia 1 (nunca silêncio): se o LLM vier vazio ou falhar, cai no fallback genérico.
  let reply = '';
  try { const out = await chamarChatLLM(messages, keys, require('./ia-modelos').resolverModelos(tdb)); reply = ((out && out.content) || '').trim(); }
  catch (e) { console.error('[autoResponder] LLM falhou:', e.message); }
  if (!reply) reply = require('./whatsapp-adapter').FALLBACK_SEM_RESPOSTA;
  // Guarda de saída do roteiro: com uma etapa pendente, o link não sai, por mais
  // que as instruções do canal mandem oferecê-lo (ver semLinkNoRoteiro).
  try { reply = require('./roteiro-conversa').semLinkNoRoteiro(tdb, conversaId, reply); }
  catch (e) { console.error('[autoResponder] guarda do roteiro:', e.message); }

  await entregar(reply);

  // A promessa da IA cobra o efeito: pausa com contador, não lida e aviso. Vem
  // DEPOIS do envio porque é a resposta que a produz, e a pausa não pode
  // atrapalhar a entrega — o contato precisa receber a frase de todo jeito.
  if (conversaId && prometeuAtendimentoHumano(reply)) {
    require('./conversas-routes').pausarIA(tdb, fichaConversa(),
      { motivo: 'a IA disse que alguém da equipe vai falar com o contato' });
  }
}

/**
 * A IA prometeu que alguém vai falar com o contato? (02/10/2026)
 *
 * Ela faz isso quando a base não tem a resposta, e as instruções mandam
 * encaminhar em vez de inventar. A frase cria uma obrigação para a empresa, e
 * sem efeito nenhum ela é promessa vazia: a conversa não subiria para as não
 * lidas, ninguém seria avisado, e a IA responderia a mensagem seguinte como se
 * nada tivesse sido prometido.
 *
 * Mede-se a PROMESSA, e não o "não sei": é ela que obriga. Por isso o aviso
 * vale também quando a IA diz que o dono retorna com a proposta — ali alguém
 * precisa retornar do mesmo jeito.
 */
const RE_PROMETEU_GENTE = new RegExp(
  '\\b(vou (pedir|encaminhar|chamar|passar|verificar com|falar com)'
  + '|encaminh(ar|o|ando) (para|ao|à|a) '
  + '|algu[ée]m (da equipe|do time|j[áa] (vem|est[áa] vindo|vai))'
  + '|um(a)? atendente'
  + '|(nossa|minha) equipe (vai|j[áa]|entra)'
  + '|entrar[áa] em contato|entra em contato|vai entrar em contato'
  + '|vai (te )?(chamar|responder|retornar)|retorna (com|em breve)'
  + '|respond(er|e) pessoalmente)\\b', 'i');

function prometeuAtendimentoHumano(texto) {
  const t = String(texto || '');
  return !!t.trim() && RE_PROMETEU_GENTE.test(t);
}

const POSITIVE_INTENT_RE = /\b(sim|quero|topo|bora|manda|mande|pode mandar|pode enviar|me envia|me manda|tenho interesse|interessado|interessada|ok|vamos|partiu|me explica)\b/i;

function buildLeadReply(cfg, texto) {
  const isShort = texto.trim().length <= 80;
  const positive = isShort && POSITIVE_INTENT_RE.test(texto);
  if (positive) {
    const tpl = (cfg.lead_positive_msg && String(cfg.lead_positive_msg).trim()) || 'Show! Vou te passar os detalhes agora. {link}';
    const base = (cfg.lead_link_base && String(cfg.lead_link_base).trim()) || '';
    return tpl.includes('{link}') ? tpl.split('{link}').join(base).trim() : (base ? (tpl + '\n\n' + base) : tpl);
  }
  return (cfg.lead_ack_msg && String(cfg.lead_ack_msg).trim()) || 'Opa, recebido! Já te retornamos por aqui.';
}

// Opt-out de lead de campanha: registra descadastro + confirma. Preserva o comportamento
// que vivia no antigo handleCampaignLead. Retorna true se tratou (e aí não segue pra IA).
//
// Vale para quem recebeu campanha, nova ou legado. Quem nunca recebeu segue o
// fluxo normal: um cliente que escreve "cancelar" falando de um pedido não
// pode sair de todas as campanhas por isso. Até 29/09 só a legado contava, e o
// pedido ia só para a lista de bloqueio dela: a campanha nova e a ficha não
// ficavam sabendo.
async function handleOptOut(tdb, jid, texto, canalId = null) {
  if (!OPT_OUT_RE.test(texto)) return false;
  const num = jid.split('@')[0];
  const dest = require('./comm-destinos');
  const tel = dest.normalizarDestino('whatsapp', num);
  const recebeu = (sql, ...args) => { try { return !!tdb.prepare(sql).get(...args); } catch (_) { return false; } };
  const deCampanha = recebeu('SELECT 1 FROM wa_campanha_dest WHERE telefone IN (?, ?) OR jid = ? LIMIT 1', num, tel || num, jid)
    || (tel && recebeu("SELECT 1 FROM comm_envios WHERE canal = 'whatsapp' AND destino = ? AND status = 'enviado' LIMIT 1", tel));
  if (!deCampanha) return false;
  try {
    tdb.transaction(() => {
      dest.descadastrarWhatsApp(tdb, num, { origem: 'resposta', motivo: String(texto).slice(0, 200) });
      // O envio a que ele respondeu, como antes; os pendentes saem na função acima.
      tdb.prepare(`UPDATE wa_campanha_dest SET status = 'optout' WHERE id = (SELECT id FROM wa_campanha_dest
        WHERE telefone IN (?, ?) OR jid = ? ORDER BY id DESC LIMIT 1)`).run(num, tel || num, jid);
    })();
  } catch (e) { console.error('[optout]', e.message); }
  // Confirmação de descadastro nunca pode ficar segurada por limite: quem
  // pediu para sair tem que ver a resposta na hora.
  await enviarWhatsApp(tdb, { telefone: num, texto: 'Tudo certo, você não recebe mais nossas mensagens.', ignorarRitmo: true, canalId }).catch(() => {});
  return true;
}

// Métrica (decisão b2): marca o dest como 'respondeu' na 1ª resposta. NÃO decide roteamento
// (sem handoff) — serve só pro filtro "Responderam". Só afeta linhas ainda em 'enviado'.
function marcarRespondeu(tdb, jid) {
  const num = jid.split('@')[0];
  try {
    tdb.prepare("UPDATE wa_campanha_dest SET status = 'respondeu' WHERE status = 'enviado' AND (telefone = ? OR jid = ?)").run(num, jid);
  } catch (_) {}
}

/**
 * Roteiro de qualificação (roteiro-conversa.js): a cada mensagem do lead, a IA
 * marca as respostas que ele deu, ANTES de o atendente de IA responder, para a
 * resposta já seguir para a próxima etapa. Falha aqui não pode calar o
 * atendimento: o erro vai para o log e a conversa segue.
 */
async function qualificarPeloRoteiro(tdb, canal, jid) {
  try {
    const conversa = tdb.prepare('SELECT * FROM conv_conversas WHERE jid = ? AND canal = ? AND canalId = ?')
      .get(jid, plataformaDo(canal), (canal && canal.id) || 0);
    if (!conversa) return null;
    const r = await require('./roteiro-conversa').qualificarPelaIA(tdb, conversa);
    // Só ESTA passagem sabe que o roteiro acabou de fechar: gravado o
    // resultado, a leitura seguinte diz apenas que ele está terminado, e a
    // mensagem de término sairia de novo a cada mensagem do contato.
    return (r && r.mudou && r.fim && r.resultado) ? r.resultado : null;
  } catch (e) { console.error('[whatsapp-webhook] roteiro:', e.message); return null; }
}

/**
 * A mensagem é o atendimento AUTOMÁTICO do contato, e não ele falando?
 * (09/10/2026)
 *
 * O WhatsApp Business responde a saudação, ou o aviso de ausência, sozinho e em
 * segundos, e para o webhook isso é mensagem como qualquer outra. Em 06/10 a IA
 * respondeu "Dr. Cell agradece seu contato. Como podemos ajudar?" quatro
 * segundos depois do disparo da campanha, e emendou a primeira pergunta do
 * roteiro: a etapa foi gasta falando com uma máquina, e o dono do número abriu o
 * WhatsApp com uma pergunta já respondida por ela. No 1bit isso alcançou 9
 * contatos. Pior que a etapa perdida é o ping-pong: o aviso de ausência sai a
 * cada mensagem nossa, e as duas máquinas se respondem até o limite por hora.
 *
 * São dois sinais, e o primeiro é técnico: o WhatsApp Business prefixa a
 * saudação automática com o LTR mark (U+200E), que não aparece no que uma pessoa
 * digita — as 21 mensagens recebidas com ele no 1bit são todas saudação de
 * empresa, e nenhuma é alguém falando. Ele não cobre tudo (a do Dr. Cell veio
 * sem), e aí vale o segundo: a frase de atendimento automático SOMADA à janela
 * curta depois de uma mensagem nossa. Os dois juntos, porque nenhum basta
 * sozinho: a frase sem a janela recusaria quem escreve "como posso te ajudar" de
 * verdade, e a janela sem a frase recusaria o "👍" que chega em 17 segundos.
 */
const AUTO_RESP_JANELA_S = 60;
const semAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// Terceira pessoa e primeira do plural, que é como uma empresa fala de si:
// "agradeço o contato" é alguém digitando, e fica de fora.
const RE_AUTO_RESPOSTA = new RegExp([
  '(agradece|agradecemos)( muito)? (o |a |seu |sua |pelo |pela )?(contato|mensagem|preferencia)',
  'horario de (funcionamento|atendimento|expediente)',
  '(mensagem|resposta) automatica',
  'um (de nossos |dos nossos )?(atendentes|representante|consultor)',
  '(retornaremos|retornarei|retornara|responderemos) ',
  'assim que (possivel|estiver|retornarmos|um atendente)',
  'seja bem.?vindo',
  'como (podemos|posso) (te |lhe )?(ajudar|atender)',
  'fora do (nosso )?horario',
  'nosso numero .{0,24}mudou',
].join('|'), 'i');

function ehAutoResposta(tdb, instance, jid, texto) {
  const t = String(texto || '');
  if (/^\s*‎/.test(t)) return true;
  if (!RE_AUTO_RESPOSTA.test(semAcento(t))) return false;
  // A janela se mede pelos timestamps gravados, e não pelo relógio: webhook
  // reentregue horas depois nasceria dentro de qualquer janela contada de agora.
  const q = tdb.prepare(`SELECT MAX(CASE WHEN from_me = 1 THEN timestamp END) AS nossa,
      MAX(CASE WHEN from_me = 0 THEN timestamp END) AS dele
    FROM whatsapp_messages WHERE remote_jid = ? AND COALESCE(instance, ?) = ?`)
    .get(jid, instance, instance);
  if (!q || q.nossa == null || q.dele == null) return false;
  return q.dele - q.nossa >= 0 && q.dele - q.nossa <= AUTO_RESP_JANELA_S;
}

/**
 * Esta mensagem ainda é a ÚLTIMA fala do contato? (09/10/2026)
 *
 * Quem manda "Claro" e, dois segundos depois, "Boa Noite", recebia DUAS
 * respostas: o webhook chama o atendimento por mensagem, sem `await` e sem fila,
 * e as duas passagens correm juntas — nenhuma vê a resposta da outra, nem no
 * histórico do prompt nem no limite por hora. Foi o que saiu para o 559491839708
 * em 05/10, a mesma pergunta do roteiro duas vezes, em duas redações do modelo.
 *
 * Serializar não resolveria: com a etapa ainda pendente, a segunda passagem
 * perguntaria de novo, só mais tarde. O que resolve é a ÚLTIMA fala responder por
 * todas — quem deixou de ser a última desiste, e quem responde já tem as duas
 * mensagens no histórico. O desempate é por `id`, autoincremento, porque o
 * `timestamp` tem resolução de segundo e as duas podem cair no mesmo.
 *
 * O preço é a espera em TODA resposta da IA, e é por isso que ela é curta.
 */
const ESPERA_AGRUPAR_MS = 7000;

async function aindaEhAUltimaFala(tdb, instance, jid) {
  const ultima = () => tdb.prepare(`SELECT id FROM whatsapp_messages
      WHERE remote_jid = ? AND COALESCE(instance, ?) = ? AND from_me = 0
      ORDER BY timestamp DESC, id DESC LIMIT 1`).get(jid, instance, instance);
  const antes = ultima();
  await new Promise((r) => setTimeout(r, ESPERA_AGRUPAR_MS));
  const depois = ultima();
  return !antes || !depois || antes.id === depois.id;
}

async function handleIncoming(tdb, canal, instance, jid, texto) {
  // O atendimento automático do outro lado não é o contato falando: ninguém
  // responde, e o roteiro não gasta etapa com uma máquina. A mensagem fica
  // gravada e a conversa já subiu para as não lidas, que é onde uma pessoa a
  // pega; quando o contato escrever, a etapa sai, porque continua pendente.
  if (ehAutoResposta(tdb, instance, jid, texto)) {
    console.log(`[autoResponder] ${jid}: atendimento automatico do contato, nada enviado`);
    return;
  }
  if (await handleOptOut(tdb, jid, texto, canal && canal.id)) return; // descadastro preservado
  marcarRespondeu(tdb, jid);                               // métrica, não roteia
  // Duas mensagens seguidas recebem UMA resposta (ver `aindaEhAUltimaFala`). Vem
  // depois do opt-out, que responde na hora: quem pede para sair não espera.
  if (!(await aindaEhAUltimaFala(tdb, instance, jid))) return;
  const fechouAgora = await qualificarPeloRoteiro(tdb, canal, jid);  // marca as respostas antes de a IA responder
  await autoResponder(tdb, canal, instance, jid, texto, { fechouAgora });  // fluxo unificado: SEMPRE a IA (base da campanha)
}

/**
 * O id do WhatsApp dentro de um evento `messages.delete`.
 *
 * A Evolution emite esse evento de DOIS lugares, com formatos diferentes
 * (conferido em /opt/evolution-api, whatsapp.baileys.service.ts):
 *
 *  - do `messages.update` com a mensagem nula, que é o caso de quem apaga para
 *    todos no celular: `sendDataWebhook(MESSAGES_DELETE, { ...key, status })`,
 *    então o id vem NO TOPO, em `data.id`;
 *  - do `deleteMessage` chamado pela API dela: `{ id, key, messageType, … }`,
 *    e aí `data.id` é o id INTERNO da Evolution (uuid), não o do WhatsApp —
 *    o que serve é `data.key.id`.
 *
 * Trocar um pelo outro marcaria a mensagem errada, ou nenhuma. Por isso
 * `data.key.id` tem precedência, e só na falta dele vale o `data.id`.
 */
function idApagado(data) {
  const d = data || {};
  if (d.key && d.key.id) return String(d.key.id);
  return d.id ? String(d.id) : null;
}

function marcarApagada(tdb, evt) {
  const id = idApagado(evt.data);
  if (!id) return;
  try {
    const r = tdb.prepare(
      `UPDATE whatsapp_messages SET apagadaEm = ?
        WHERE wa_message_id = ? AND instance = ? AND apagadaEm IS NULL`
    ).run(new Date().toISOString(), id, evt.instance);
    if (!r.changes) console.log(`[whatsapp-webhook] apagada ${id}: não está no histórico`);
  } catch (e) {
    console.error('[whatsapp-webhook] marcarApagada:', e.message);
  }
}

/**
 * Os ticks do WhatsApp, pelo `messages.update` da Evolution.
 *
 * O ack NÃO é monotônico na chegada: o WhatsApp reentrega eventos e a Evolution
 * os repassa na ordem em que o Baileys os vê, então DELIVERY_ACK chega atrasado
 * depois de READ e faria o balão voltar de dois tiques azuis para dois cinzas
 * na frente de quem está lendo. Daí a ESCADA: o status só avança.
 *
 * `ERROR` é a exceção e grava sempre, porque é o único que precisa aparecer
 * mesmo contrariando a escada — mensagem que falhou depois de aceita pelo
 * servidor ficaria dita como entregue.
 */
const ESCADA_ACK = { PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 };

function marcarStatus(tdb, evt) {
  const d = evt.data || {};
  // O id do WhatsApp: `keyId` é o que a Evolution manda no update (`messageId`
  // é o id INTERNO dela, de outro banco, e não casa com nada aqui).
  const id = d.keyId ? String(d.keyId) : (d.key && d.key.id ? String(d.key.id) : null);
  const novo = String(d.status || '').toUpperCase();
  if (!id || !novo) return;
  if (novo !== 'ERROR' && !ESCADA_ACK[novo]) return;
  try {
    // `from_me = 1` porque é só o que a tela desenha: o ack de mensagem
    // RECEBIDA é a nossa própria leitura dela, e escrever isso seria uma
    // escrita por mensagem lida, à toa.
    const r = tdb.prepare(
      `UPDATE whatsapp_messages SET status = ?
        WHERE wa_message_id = ? AND instance = ? AND from_me = 1
          AND (status IS NULL OR ? = 'ERROR'
               OR COALESCE(?, 0) > COALESCE(CASE status
                    WHEN 'PENDING' THEN 1 WHEN 'SERVER_ACK' THEN 2 WHEN 'DELIVERY_ACK' THEN 3
                    WHEN 'READ' THEN 4 WHEN 'PLAYED' THEN 5 END, 0))`
    ).run(novo, id, evt.instance, novo, ESCADA_ACK[novo] || 0);
    return r.changes;
  } catch (e) {
    console.error('[whatsapp-webhook] marcarStatus:', e.message);
  }
}

function registrarRotaWebhook(app, { tenantManager }) {
  app.post('/api/whatsapp/webhook', (req, res) => {
    res.sendStatus(200); // responde já; Evolution reenfileira em caso de erro
    try {
      const evt = req.body || {};
      if (evt.event !== 'messages.upsert' && evt.event !== 'messages.delete'
        && evt.event !== 'messages.update') return;

      const slug = slugFromInstance(evt.instance, tenantManager);
      if (!slug || !tenantManager.getTenantBySlug(slug)) return;

      const tdb = tenantManager.getDb(slug);
      migrarQueue(tdb);

      // Apagada no WhatsApp: a mensagem FICA, e só ganha a data da exclusão.
      // Quem apaga tira do aparelho dele, e não do nosso registro — é por isso
      // que esta é a única escrita deste caminho.
      if (evt.event === 'messages.delete') {
        marcarApagada(tdb, evt);
        return;
      }
      // Confirmação de entrega e de leitura: só o status da mensagem muda.
      // Nada mais deste caminho roda — ack não é mensagem nova, não sobe a
      // conversa na lista, não chama a IA e não avisa ninguém.
      if (evt.event === 'messages.update') {
        marcarStatus(tdb, evt);
        return;
      }
      // O número por onde a mensagem entrou. Empresa ainda sem canal
      // cadastrado (antes da migração) segue com canal nulo, como antes.
      const canal = canais.canalPorInstance(tdb, evt.instance);

      const data = evt.data || {};
      const key = data.key || {};
      const jid = jidCanonico(key);
      if (!jid || jid === 'status@broadcast') return;
      // Grupo não é atendimento: nada aqui embaixo o consome (a central, o
      // histórico da IA e o anti-flood são todos por conversa 1:1) e gravar
      // encheria a tabela — só esta instância tem 95 mil mensagens de grupo.
      if (jid.endsWith('@g.us')) return;
      const texto = extractText(data.message);

      // A EDIÇÃO não é mensagem nova: ela troca o texto da mensagem já
      // recebida, como no WhatsApp. Gravar o envelope cifrado em que ela chega
      // (`secretEncryptedMessage`) deixava um balão sem conteúdo no meio da
      // conversa, e o texto editado não aparecia em lugar nenhum — o porquê e
      // como se abre estão no `wa-edicao.js`.
      const waEdicao = require('./wa-edicao');
      const edicao = waEdicao.lerEdicao(data);
      if (edicao) {
        waEdicao.aplicarEdicao(tdb, edicao);
        // Metade das edições chega sem o segredo no próprio envelope, e aí ele
        // está na mensagem original, que a Evolution guarda. Sem `await`: o
        // webhook responde na hora, e o texto entra no histórico logo depois.
        if (!edicao.texto) {
          waEdicao.completarPelaOriginal(tdb, canal ? canal.id : null, data, edicao.alvo)
            .catch(e => console.error('[whatsapp-webhook] edicao:', e.message));
        }
        return;
      }

      // A reação guarda o emoji no texto e a mensagem reagida no `citaWaId`.
      const reacao = daReacao(data.message);
      const info = tdb.prepare(
        `INSERT OR IGNORE INTO whatsapp_messages
           (wa_message_id, instance, remote_jid, from_me, push_name, texto, message_type, timestamp, citaWaId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        key.id || null, evt.instance, jid, key.fromMe ? 1 : 0,
        data.pushName || null, reacao ? reacao.emoji : texto, data.messageType || null,
        data.messageTimestamp || Math.floor(Date.now() / 1000),
        reacao ? reacao.alvo : idCitado(data.message)
      );

      // A mídia é guardada AGORA, e não quando alguém abre a conversa. O link
      // do WhatsApp expira em torno de 26 dias (medido no 1bit em 01/10/2026:
      // 05/09 ainda baixava, 04/09 e todos os 14 dias testados antes dele, não)
      // e nada avisa — a conversa aberta no mês seguinte mostrava
      // "Mídia indisponível" sem haver o que fazer. Figurinha fica de fora,
      // pela lista `TIPOS_GUARDAR`.
      if (info.changes > 0) {
        require('./wa-midia').guardarAgora(tdb, slug, info.lastInsertRowid, data.messageType);
      }

      // A reação não mexe na conversa: ela não é mensagem nova, não sobe a
      // conversa na lista e não conta como não lida. Até 02/10 ela fazia as
      // três coisas, e a prévia da lista virava um emoji solto.
      if (reacao) return;

      // Mantém a conversa da central em dia: é ela que a tela de atendimento
      // lê. Sem isto o inbox só enxergaria mensagem, nunca estado nem dono.
      if (info.changes > 0 && jid.endsWith('@s.whatsapp.net')) {
        try {
          // pushName de mensagem enviada é o do DONO da instância, não o do
          // contato — passá-lo batizava a conversa com o nome de quem atende.
          // Sem texto, a prévia da lista diz o tipo da mídia, em vez de "sem
          // mensagem". Só a prévia: o texto gravado segue vazio, e a IA não
          // responde a um "Imagem" que ninguém escreveu.
          const ROTULO = { imageMessage: 'Imagem', videoMessage: 'Vídeo', audioMessage: 'Áudio',
            documentMessage: 'Documento', documentWithCaptionMessage: 'Documento', stickerMessage: 'Figurinha',
            templateMessage: 'Imagem', ptvMessage: 'Vídeo',
            // O que não é mídia e também não tem texto. Sem estes, a prévia da
            // lista ficava em branco e a conversa parecia vazia (02/10).
            contactMessage: 'Contato', contactsArrayMessage: 'Contatos',
            locationMessage: 'Localização', liveLocationMessage: 'Localização em tempo real',
            listMessage: 'Lista de opções', buttonsMessage: 'Mensagem com botões',
            albumMessage: 'Álbum', pollCreationMessage: 'Enquete', pollUpdateMessage: 'Voto em enquete',
            secretEncryptedMessage: 'Mensagem protegida' };
          require('./conversas-routes').registrarMensagem(tdb, {
            jid, texto: texto || ROTULO[data.messageType] || null, deMim: !!key.fromMe,
            nome: key.fromMe ? null : (data.pushName || null),
            canalId: canal ? canal.id : 0,
          });
        } catch (e) { console.error('[whatsapp-webhook] conversa:', e.message); }
      }

      // auto-resposta: só para mensagem NOVA (não duplicada), recebida, 1:1, com texto
      if (info.changes > 0 && !key.fromMe && jid.endsWith('@s.whatsapp.net') && texto) {
        handleIncoming(tdb, canal, evt.instance, jid, texto)
          .catch(e => console.error('[whatsapp-webhook] handleIncoming:', e.message));

        // Pop-up de mensagem nova. Mesmas condições da auto-resposta, e pela
        // mesma razão: mensagem repetida pelo webhook (changes = 0) acordaria a
        // equipe duas vezes pela mesma coisa, e eco do que NÓS mandamos
        // (`key.fromMe`) não é motivo para acordar ninguém.
        //
        // Sem `await`: o webhook precisa devolver 200 rápido para a Evolution,
        // e um servidor de push lento não pode segurar o recebimento — que é a
        // única parte deste caminho que não se recupera depois.
        require('./push-routes').avisarInscritos(tdb)
          .catch(e => console.error('[whatsapp-webhook] push:', e.message));
      }
    } catch (e) {
      console.error('[whatsapp-webhook]', e.message);
    }
  });

  console.log('[WhatsApp] Webhook público registrado em /api/whatsapp/webhook');
}

// `handleIncoming` é exportado para o meta-adapter.js: Messenger e Instagram
// entram por outro webhook e caem no MESMO atendimento (opt-out, roteiro, IA).
module.exports = { extractText, idCitado, daReacao, registrarRotaWebhook, idApagado, marcarStatus, buildLeadReply, handleOptOut, jidCanonico, slugFromInstance, autoResponder, prometeuAtendimentoHumano, qualificarPeloRoteiro, handleIncoming, ehAutoResposta };
