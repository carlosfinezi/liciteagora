/**
 * comm-destinos.js — quem pode receber, em que endereço, e quem pediu para sair.
 *
 * O que faltava e este módulo resolve:
 *
 *  1. Opt-out era só do WhatsApp e só por telefone (`wa_optout`). No 1bit há 27
 *     pessoas que pediram para parar de receber — e uma campanha de e-mail
 *     alcançaria todas elas, porque o canal e-mail não tinha descadastro
 *     nenhum. Isso é a mesma pessoa sendo contatada depois de dizer não
 *     (LGPD art. 18).
 *  2. Destino não era validado. "joao@" e "1234" viravam envio, e o modo
 *     simulado ainda contava como sucesso.
 *  3. Não havia deduplicação por destino. Matriz e filial com o mesmo e-mail
 *     recebiam a mesma mensagem duas vezes — que é como um domínio vira spam.
 *  4. Placeholder desconhecido ia literal: o cliente recebia "Olá {{fone}}".
 *  5. `pessoas.aceitaEmailMarketing` e `aceitaWhatsappMarketing` existiam, eram
 *     editáveis no cadastro do cliente — e NENHUM código de envio lia. No 1bit
 *     são 29 pessoas com o WhatsApp marcado como recusado que uma campanha
 *     alcançaria assim mesmo. Consentimento coletado e ignorado é pior que
 *     consentimento não coletado: dá a aparência de conformidade.
 */

const CANAIS = ['email', 'whatsapp'];

// Campanha de marketing exige consentimento; comunicação operacional (aviso de
// entrega, cobrança, documento fiscal) se apoia em execução de contrato e não
// exige — mas o opt-out vale para as duas, sempre.
const TIPOS_CAMPANHA = ['marketing', 'operacional'];
const COLUNA_CONSENTIMENTO = { email: 'aceitaEmailMarketing', whatsapp: 'aceitaWhatsappMarketing' };

// Placeholders que renderizar() sabe substituir. Qualquer outro é erro de
// template, não texto.
const VARIAVEIS = ['razaoSocial', 'nomeFantasia', 'primeiroNome', 'cpfCnpj', 'email', 'telefone'];

const erro = (codigo, mensagem, extra = {}) => ({ nivel: 'erro', codigo, mensagem, ...extra });
const aviso = (codigo, mensagem, extra = {}) => ({ nivel: 'aviso', codigo, mensagem, ...extra });

function migrarDB(db) {
  db.exec(`
    -- Opt-out de verdade: por canal e por destino normalizado, com a origem
    -- registrada. Sem 'origem' não dá para provar de onde veio o pedido, e é
    -- exatamente isso que a LGPD cobra.
    CREATE TABLE IF NOT EXISTS comm_optout (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canal TEXT NOT NULL,
      destino TEXT NOT NULL,
      pessoaId INTEGER,
      origem TEXT NOT NULL DEFAULT 'manual',
      motivo TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_optout_canal_destino ON comm_optout(canal, destino);
    CREATE INDEX IF NOT EXISTS idx_optout_pessoa ON comm_optout(pessoaId);
  `);

  try { db.exec('ALTER TABLE comm_envios ADD COLUMN dia TEXT'); } catch { /* já existe */ }
  try { db.exec('ALTER TABLE comm_envios ADD COLUMN motivoDescartado TEXT'); } catch { /* já existe */ }
  try { db.exec('ALTER TABLE comm_campanhas ADD COLUMN totalDescartados INTEGER DEFAULT 0'); } catch { /* já existe */ }
  // 'marketing' como padrão é a escolha conservadora: se ninguém disser o
  // contrário, a campanha respeita o consentimento.
  try { db.exec("ALTER TABLE comm_campanhas ADD COLUMN tipo TEXT DEFAULT 'marketing'"); } catch { /* já existe */ }

  // Os opt-outs de WhatsApp já registrados não podem se perder na unificação:
  // são pessoas que pediram para parar, e reenviar para elas é o pior erro
  // possível deste módulo.
  try {
    const tem = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wa_optout'").get();
    if (tem) {
      db.prepare(`INSERT OR IGNORE INTO comm_optout (canal, destino, origem, dataCriacao)
        SELECT 'whatsapp', telefone, 'wa_optout', criado_em FROM wa_optout WHERE telefone IS NOT NULL`).run();
    }
  } catch (e) {
    console.warn('[comm] migração de wa_optout:', e.message);
  }
}

// ==================== NORMALIZAÇÃO ====================

/**
 * E-mail normalizado, ou null se não for um e-mail.
 *
 * Normalizar é o que faz a deduplicação e o opt-out funcionarem: "Joao@X.com"
 * e "joao@x.com " são a mesma caixa, e sem baixar para o mesmo texto a pessoa
 * que se descadastrou continuaria recebendo.
 */
function normalizarEmail(valor) {
  const t = String(valor || '').trim().toLowerCase();
  if (!t) return null;
  // Deliberadamente conservador: exige usuário, arroba, domínio com ponto e
  // TLD de 2+ letras. Não cobre todo o RFC, cobre o que existe na prática.
  if (!/^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(t)) return null;
  if (t.length > 254) return null;
  const tld = t.split('.').pop();
  if (!/^[a-z]{2,}$/.test(tld)) return null;
  return t;
}

/**
 * Telefone brasileiro em dígitos, com DDI 55 e o nono dígito quando é celular.
 *
 * Guardar "(91) 98888-7777" e "5591988887777" como coisas diferentes fazia o
 * opt-out não casar: a pessoa se descadastrava e o número voltava na campanha
 * seguinte escrito de outro jeito.
 */
function normalizarTelefone(valor) {
  let d = String(valor || '').replace(/\D/g, '');
  if (!d) return null;

  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  // Já veio com DDI 55.
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);

  if (d.length === 11) {
    // Celular: DDD + 9 + 8 dígitos.
    if (!/^[1-9][1-9]9\d{8}$/.test(d)) return null;
    return '55' + d;
  }
  if (d.length === 10) {
    // Fixo, ou celular antigo sem o nono dígito. Prefixo 6-9 é móvel: acrescenta
    // o 9, senão a mensagem nunca chega.
    if (!/^[1-9][1-9]\d{8}$/.test(d)) return null;
    const ddd = d.slice(0, 2), resto = d.slice(2);
    if (/^[6-9]/.test(resto)) return '55' + ddd + '9' + resto;
    return '55' + d;
  }
  return null;
}

function normalizarDestino(canal, valor) {
  if (canal === 'email') return normalizarEmail(valor);
  if (canal === 'whatsapp') return normalizarTelefone(valor);
  return null;
}

const destinoBruto = (canal, pessoa) => {
  if (canal === 'email') return pessoa.email || null;
  if (canal === 'whatsapp') return pessoa.telefone || null;
  return null;
};

/**
 * A pessoa autorizou marketing neste canal?
 *
 * A coluna existe no cadastro desde sempre e nenhum envio a consultava.
 * Devolve null quando a coluna não existe no tenant — aí a regra não roda, em
 * vez de bloquear todo mundo por causa de um schema antigo.
 */
function aceitaMarketing(pessoa, canal) {
  const coluna = COLUNA_CONSENTIMENTO[canal];
  if (!coluna || !(coluna in pessoa)) return null;
  return Number(pessoa[coluna]) === 1;
}

// ==================== OPT-OUT ====================

function estaOptOut(db, canal, destino) {
  const d = normalizarDestino(canal, destino);
  if (!d) return false;
  return !!db.prepare('SELECT 1 FROM comm_optout WHERE canal = ? AND destino = ?').get(canal, d);
}

function registrarOptOut(db, { canal, destino, pessoaId, origem, motivo }) {
  if (!CANAIS.includes(canal)) throw new Error(`canal inválido: use ${CANAIS.join(' ou ')}`);
  const d = normalizarDestino(canal, destino);
  if (!d) throw new Error(`Destino inválido para o canal ${canal}: ${destino}`);
  db.prepare(`INSERT INTO comm_optout (canal, destino, pessoaId, origem, motivo)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(canal, destino) DO UPDATE SET
      pessoaId = COALESCE(excluded.pessoaId, comm_optout.pessoaId),
      motivo = COALESCE(excluded.motivo, comm_optout.motivo)`)
    .run(canal, d, pessoaId || null, origem || 'manual', motivo || null);

  // Mantém wa_optout em dia: o runner do WhatsApp ainda a consulta.
  if (canal === 'whatsapp') {
    try { db.prepare('INSERT OR IGNORE INTO wa_optout (telefone) VALUES (?)').run(d); } catch { /* tabela ausente */ }
  }
  return { canal, destino: d };
}

/**
 * Reinclusão. Exige confirmação explícita de quem manda porque desfazer um
 * "não me mande mais" é decisão de risco, não correção de digitação.
 */
function removerOptOut(db, canal, destino) {
  const d = normalizarDestino(canal, destino);
  if (!d) throw new Error('Destino inválido');
  const r = db.prepare('DELETE FROM comm_optout WHERE canal = ? AND destino = ?').run(canal, d);
  if (canal === 'whatsapp') {
    try { db.prepare('DELETE FROM wa_optout WHERE telefone = ?').run(d); } catch { /* tabela ausente */ }
  }
  return { removidos: r.changes };
}

// ==================== TEMPLATE ====================

function renderizar(texto, pessoa) {
  if (!texto) return '';
  const primeiroNome = (pessoa.razaoSocial || '').trim().split(/\s+/)[0] || '';
  const vars = {
    razaoSocial: pessoa.razaoSocial || '',
    nomeFantasia: pessoa.nomeFantasia || pessoa.razaoSocial || '',
    primeiroNome,
    cpfCnpj: pessoa.cpfCnpj || '',
    email: pessoa.email || '',
    telefone: pessoa.telefone || '',
  };
  return String(texto).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
}

/** Placeholders que o template usa e o renderizador não conhece. */
function placeholdersDesconhecidos(texto) {
  const achados = new Set();
  for (const m of String(texto || '').matchAll(/\{\{(\w+)\}\}/g)) {
    if (!VARIAVEIS.includes(m[1])) achados.add(m[1]);
  }
  return Array.from(achados);
}

function validarTemplate(dados) {
  const p = [];
  if (!dados.nome || !String(dados.nome).trim()) p.push(erro('nome_obrigatorio', 'Nome do template obrigatório'));
  if (!CANAIS.includes(dados.canal)) p.push(erro('canal_invalido', `canal deve ser ${CANAIS.join(' ou ')}`));
  if (!dados.corpo || !String(dados.corpo).trim()) p.push(erro('corpo_obrigatorio', 'Corpo da mensagem obrigatório'));

  const desconhecidos = [
    ...placeholdersDesconhecidos(dados.corpo),
    ...placeholdersDesconhecidos(dados.assunto),
  ];
  if (desconhecidos.length) {
    // Vai literal para o destinatário: "Olá {{fone}}". Barrar aqui é a única
    // chance de pegar antes de mil pessoas receberem.
    p.push(erro('placeholder_desconhecido',
      `Placeholder não reconhecido: ${desconhecidos.map((x) => `{{${x}}}`).join(', ')}. `
      + `Disponíveis: ${VARIAVEIS.map((v) => `{{${v}}}`).join(', ')}`,
      { placeholders: desconhecidos }));
  }

  if (dados.canal === 'email' && !String(dados.assunto || '').trim()) {
    p.push(aviso('assunto_vazio', 'E-mail sem assunto tem alta chance de cair em spam'));
  }
  if (dados.canal === 'whatsapp' && String(dados.corpo || '').length > 4096) {
    p.push(erro('corpo_muito_longo', 'WhatsApp aceita no máximo 4096 caracteres'));
  }
  return p;
}

// ==================== PREPARAÇÃO DA CAMPANHA ====================

/**
 * Resolve a lista em destinatários efetivos.
 *
 * Devolve o que vai ser enviado E o que foi descartado, com motivo. Uma
 * campanha que diz "500 enviados" sem dizer que 120 estavam em opt-out e 30
 * tinham e-mail inválido dá uma taxa de sucesso que não existe.
 */
function prepararDestinatarios(db, { listaId, canal, tipo }) {
  const exigeConsentimento = (tipo || 'marketing') === 'marketing';
  // LEFT JOIN e não JOIN: a lista aceita contato avulso (digitado à mão), que
  // não existe em pessoas. Nesse caso o destino vem da própria linha do membro.
  const membros = db.prepare(`
    SELECT p.*, m.destinoManual, m.nomeManual, m.id AS membroId
    FROM comm_lista_membros m
    LEFT JOIN pessoas p ON p.id = m.pessoaId
    WHERE m.listaId = ?
    ORDER BY COALESCE(p.id, m.id)`).all(listaId)
    .map(r => r.id ? r : {
      // Avulso: monta uma "pessoa" mínima, com o mesmo formato que o resto do
      // fluxo espera (renderização de {{razaoSocial}}, descarte, dedup).
      id: null, membroId: r.membroId, razaoSocial: r.nomeManual || r.destinoManual,
      nomeFantasia: null, cpfCnpj: null, email: null, telefone: r.destinoManual,
      avulso: true,
    });

  const optouts = new Set(db.prepare('SELECT destino FROM comm_optout WHERE canal = ?')
    .all(canal).map((r) => r.destino));

  const enviar = [];
  const descartados = [];
  const vistos = new Map();

  for (const p of membros) {
    const bruto = destinoBruto(canal, p);
    if (!bruto) {
      descartados.push({ pessoaId: p.id, nome: p.razaoSocial, destino: null,
        motivo: canal === 'email' ? 'sem e-mail cadastrado' : 'sem telefone cadastrado' });
      continue;
    }
    const destino = normalizarDestino(canal, bruto);
    if (!destino) {
      descartados.push({ pessoaId: p.id, nome: p.razaoSocial, destino: bruto,
        motivo: canal === 'email' ? 'e-mail inválido' : 'telefone inválido' });
      continue;
    }
    if (optouts.has(destino)) {
      descartados.push({ pessoaId: p.id, nome: p.razaoSocial, destino, motivo: 'pediu para não receber (opt-out)' });
      continue;
    }
    // Opt-out vale sempre; consentimento só para marketing. Aviso de entrega e
    // cobrança se apoiam em execução de contrato.
    // Avulso não tem cadastro para consultar consentimento. Quem digitou o
    // número assume a responsabilidade — mas o opt-out acima continua valendo.
    if (exigeConsentimento && !p.avulso && aceitaMarketing(p, canal) === false) {
      descartados.push({ pessoaId: p.id, nome: p.razaoSocial, destino,
        motivo: 'não autorizou marketing neste canal' });
      continue;
    }
    if (vistos.has(destino)) {
      descartados.push({ pessoaId: p.id, nome: p.razaoSocial, destino,
        motivo: `destino repetido — já vai para ${vistos.get(destino)}` });
      continue;
    }
    vistos.set(destino, p.razaoSocial || `pessoa #${p.id}`);
    enviar.push({ pessoa: p, destino });
  }

  return {
    membros: membros.length,
    enviar,
    descartados,
    tipo: tipo || 'marketing',
    resumo: {
      total: membros.length,
      elegiveis: enviar.length,
      semDestino: descartados.filter((d) => /sem (e-mail|telefone)/.test(d.motivo)).length,
      invalidos: descartados.filter((d) => /inválido/.test(d.motivo)).length,
      optout: descartados.filter((d) => /opt-out/.test(d.motivo)).length,
      semConsentimento: descartados.filter((d) => /não autorizou/.test(d.motivo)).length,
      duplicados: descartados.filter((d) => /repetido/.test(d.motivo)).length,
    },
  };
}

// ==================== JANELA DE ENVIO ====================

/**
 * Mensagem promocional às 3h da manhã queima a marca e rende denúncia. A
 * janela é configurável porque cobrança e aviso operacional têm regras
 * diferentes de campanha comercial.
 */
function janelaPermitida(db, agora) {
  const ler = (k, padrao) => {
    try {
      const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(k);
      return r && r.valor != null && r.valor !== '' ? r.valor : padrao;
    } catch { return padrao; }
  };
  if (String(ler('comm_janela_ativa', '1')) !== '1') return { permitido: true };

  const inicio = parseInt(ler('comm_janela_inicio', '8'), 10);
  const fim = parseInt(ler('comm_janela_fim', '20'), 10);
  const diasUteis = String(ler('comm_janela_dias_uteis', '0')) === '1';

  const d = agora ? new Date(agora) : new Date();
  // -3h: o servidor roda em UTC e a janela é do horário de quem recebe.
  const local = new Date(d.getTime() - 3 * 3600000);
  const hora = local.getUTCHours();
  const diaSemana = local.getUTCDay();

  if (diasUteis && (diaSemana === 0 || diaSemana === 6)) {
    return { permitido: false, motivo: 'fora dos dias úteis configurados', hora, diaSemana };
  }
  if (hora < inicio || hora >= fim) {
    return { permitido: false, motivo: `fora da janela de ${inicio}h às ${fim}h (agora ${hora}h)`, hora, diaSemana };
  }
  return { permitido: true, hora, diaSemana };
}

/**
 * O consentimento deste canal foi realmente coletado, ou a coluna está toda no
 * valor padrao?
 *
 * `aceitaEmailMarketing` e `aceitaWhatsappMarketing` sao INTEGER DEFAULT 0: o
 * zero significa tanto "recusou" quanto "nunca foi perguntado", e o banco nao
 * distingue os dois. No 1bit as 160 pessoas estao em 0 para e-mail (ninguem
 * preencheu) e 131 em 1 para WhatsApp (preenchimento real).
 *
 * Sem este diagnostico, ligar a regra faria a campanha de e-mail dizer
 * "0 elegiveis" e o usuario concluir que o sistema quebrou — quando o que
 * falta e coletar o aceite.
 */
function diagnosticoConsentimento(db, canal) {
  const coluna = COLUNA_CONSENTIMENTO[canal];
  if (!coluna) return null;
  try {
    const r = db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN ${coluna} = 1 THEN 1 ELSE 0 END) AS aceitaram
      FROM pessoas`).get();
    const total = r.total || 0;
    const aceitaram = r.aceitaram || 0;
    if (!total) return null;
    return {
      total, aceitaram,
      nuncaColetado: aceitaram === 0,
      // A coluna nasce em 0. Base inteira em 0 quase sempre significa que o
      // aceite nunca foi pedido, nao que todo mundo recusou.
      aviso: aceitaram === 0
        ? `Nenhuma das ${total} pessoas tem "aceita marketing" marcado neste canal. `
          + 'O campo nasce desmarcado — provavelmente o aceite nunca foi coletado, e não que todos recusaram. '
          + 'Colete o consentimento no cadastro, ou classifique a campanha como operacional se ela se apoia '
          + 'em execução de contrato (cobrança, aviso de entrega, documento fiscal).'
        : null,
    };
  } catch { return null; }
}

module.exports = {
  CANAIS, VARIAVEIS, TIPOS_CAMPANHA, COLUNA_CONSENTIMENTO,
  diagnosticoConsentimento,
  aceitaMarketing,
  migrarDB,
  normalizarEmail, normalizarTelefone, normalizarDestino, destinoBruto,
  estaOptOut, registrarOptOut, removerOptOut,
  renderizar, placeholdersDesconhecidos, validarTemplate,
  prepararDestinatarios,
  janelaPermitida,
};
