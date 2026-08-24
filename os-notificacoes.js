/**
 * os-notificacoes.js — dispatcher de notificações de OS.
 *
 * Extraído de os-routes.js (2026-07-31) porque o sweep de SLA vive no
 * scheduler (processo master) e precisava do mesmo dispatcher. Antes o
 * sweep fazia INSERT direto em os_eventos, pulando o dispatcher: a regra
 * de notificação para sla-risco/sla-atrasado ficava configurada e ativa
 * sem nunca enviar nada.
 *
 * O que mudou junto:
 *  - EVENTOS é a fonte única da lista. A tela lia uma lista escrita à mão
 *    que tinha 3 eventos inexistentes e faltava 2 reais.
 *  - Cada tentativa de envio vira linha em os_notificacoes_log. O canal
 *    falhava dentro de um catch silencioso, então não dar notificação
 *    nenhuma era indistinguível de tudo ter funcionado.
 */

const { enviarEmailCobranca } = require('./email-client');
const { enviarWhatsApp } = require('./whatsapp-adapter');
const { sendTelegram } = require('./telegram-client');

// Fonte única: só entra aqui evento que o sistema realmente emite.
// `automatico` = disparado por código; os demais vêm de ação do usuário.
const EVENTOS = [
  { valor: 'abertura',        texto: 'Abertura da OS' },
  { valor: 'enviado',         texto: 'Orçamento enviado' },
  { valor: 'aprovado',        texto: 'Orçamento aprovado' },
  { valor: 'rejeitado',       texto: 'Orçamento rejeitado' },
  { valor: 'inicio',          texto: 'Início de execução' },
  { valor: 'aguardando-peca', texto: 'Aguardando peça' },
  { valor: 'conclusao',       texto: 'Conclusão' },
  { valor: 'faturamento',     texto: 'Faturamento' },
  { valor: 'cancelamento',    texto: 'Cancelamento' },
  { valor: 'anexo',           texto: 'Anexo adicionado' },
  { valor: 'assinatura',      texto: 'Assinatura coletada' },
  { valor: 'sla-risco',       texto: 'SLA em risco (24h)', automatico: true },
  { valor: 'sla-atrasado',    texto: 'SLA atrasado',       automatico: true },
];
const EVENTOS_VALIDOS = EVENTOS.map(e => e.valor);

const CANAIS = [
  { valor: 'email',    texto: 'Email (cliente)' },
  { valor: 'whatsapp', texto: 'WhatsApp (cliente)' },
  { valor: 'telegram', texto: 'Telegram (admin)' },
];
const CANAIS_VALIDOS = CANAIS.map(c => c.valor);

const PLACEHOLDERS = [
  'numero', 'clienteNome', 'titulo', 'status', 'descricao',
  'prazo', 'tecnicoNome', 'assinanteNome', 'motivo',
];

function migrarNotificacoesDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS os_notificacoes_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      osId INTEGER,
      evento TEXT NOT NULL,
      canal TEXT NOT NULL,
      destino TEXT,
      status TEXT NOT NULL,
      erro TEXT,
      teste INTEGER NOT NULL DEFAULT 0,
      data TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_os_notif_log ON os_notificacoes_log(data DESC);
    CREATE INDEX IF NOT EXISTS idx_os_notif_log_os ON os_notificacoes_log(osId, data);
  `);
}

function registrarLog(db, { osId, evento, canal, destino, status, erro, teste }) {
  try {
    db.prepare(`INSERT INTO os_notificacoes_log (osId, evento, canal, destino, status, erro, teste)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(osId || null, evento, canal, destino || null, status, erro || null, teste ? 1 : 0);
  } catch { /* log não pode derrubar o envio */ }
}

function carregarDadosOS(db, osId) {
  try {
    return db.prepare(`
      SELECT o.*, p.razaoSocial AS clienteNome, p.email AS clienteEmail, p.telefone AS clienteTelefone,
             u.username AS tecnicoNome
      FROM os_ordens o
      LEFT JOIN pessoas p ON p.id = o.clienteId
      LEFT JOIN users u ON u.id = o.tecnicoId
      WHERE o.id = ?`).get(osId);
  } catch { return null; }
}

function aplicarTemplate(t, dados) {
  if (!t) return '';
  return String(t).replace(/\{\{(\w+)\}\}/g, (_m, k) => (dados[k] != null ? String(dados[k]) : ''));
}

/**
 * Envia por um canal. Devolve { ok, destino, erro } em vez de engolir —
 * quem chama decide se loga, propaga ou ignora.
 */
async function enviarPorCanal(db, canal, { texto, assunto, os }) {
  try {
    if (canal === 'email') {
      const to = os?.clienteEmail;
      if (!to) return { ok: false, destino: null, erro: 'Cliente sem email cadastrado' };
      await enviarEmailCobranca(db, { to, assunto, texto });
      return { ok: true, destino: to };
    }
    if (canal === 'whatsapp') {
      const tel = String(os?.clienteTelefone || '').replace(/\D/g, '');
      if (!tel) return { ok: false, destino: null, erro: 'Cliente sem telefone cadastrado' };
      await enviarWhatsApp(db, { telefone: tel, texto });
      return { ok: true, destino: tel };
    }
    if (canal === 'telegram') {
      await sendTelegram(db, texto);
      return { ok: true, destino: 'telegram-admin' };
    }
    return { ok: false, destino: null, erro: `Canal desconhecido: ${canal}` };
  } catch (err) {
    return { ok: false, destino: null, erro: err.message || String(err) };
  }
}

/**
 * Dispara as regras ativas do evento. Nunca lança: uma falha de canal não
 * pode derrubar a ação de negócio que gerou o evento — mas agora fica
 * registrada em os_notificacoes_log.
 */
async function dispatchNotificacoes(db, osId, tipo, descricao, payload) {
  let configs;
  try {
    configs = db.prepare(`SELECT evento, canal, template FROM os_notificacoes_config
      WHERE evento = ? AND ativo = 1`).all(tipo);
  } catch { return { enviados: 0, falhas: 0 }; }
  if (!configs || !configs.length) return { enviados: 0, falhas: 0 };

  const os = carregarDadosOS(db, osId);
  if (!os) return { enviados: 0, falhas: 0 };

  const dados = {
    ...os,
    descricao: descricao || '',
    prazo: os.dataPromessa || '—',
    motivo: payload?.motivo || '',
    assinanteNome: payload?.assinanteNome || '',
  };

  let enviados = 0, falhas = 0;
  for (const cfg of configs) {
    const texto = aplicarTemplate(cfg.template, dados)
      || `[OS ${os.numero}] ${descricao || tipo} — ${os.clienteNome || ''}`;
    const r = await enviarPorCanal(db, cfg.canal, {
      texto, assunto: `OS ${os.numero} — ${tipo}`, os,
    });
    registrarLog(db, { osId, evento: tipo, canal: cfg.canal, destino: r.destino,
      status: r.ok ? 'ok' : 'erro', erro: r.erro });
    if (r.ok) enviados++; else falhas++;
  }
  return { enviados, falhas };
}

/**
 * Envio de teste: usa uma OS real (a mais recente) só para preencher os
 * placeholders, e devolve o erro do canal em vez de esconder. É a única
 * forma de descobrir que o SMTP/instância está fora antes do evento real.
 */
async function enviarTeste(db, { evento, canal, template, osId }) {
  const os = osId ? carregarDadosOS(db, osId)
    : (() => { try { return db.prepare(`
        SELECT o.*, p.razaoSocial AS clienteNome, p.email AS clienteEmail, p.telefone AS clienteTelefone,
               u.username AS tecnicoNome
        FROM os_ordens o
        LEFT JOIN pessoas p ON p.id = o.clienteId
        LEFT JOIN users u ON u.id = o.tecnicoId
        ORDER BY o.id DESC LIMIT 1`).get(); } catch { return null; } })();

  if (!os) return { ok: false, erro: 'Nenhuma OS cadastrada para montar o teste' };

  const dados = {
    ...os, descricao: '(envio de teste)', prazo: os.dataPromessa || '—',
    motivo: '(teste)', assinanteNome: '(teste)',
  };
  const texto = '[TESTE] ' + (aplicarTemplate(template, dados)
    || `[OS ${os.numero}] ${evento} — ${os.clienteNome || ''}`);
  const r = await enviarPorCanal(db, canal, {
    texto, assunto: `[TESTE] OS ${os.numero} — ${evento}`, os,
  });
  registrarLog(db, { osId: os.id, evento, canal, destino: r.destino,
    status: r.ok ? 'ok' : 'erro', erro: r.erro, teste: 1 });
  return { ok: r.ok, destino: r.destino, erro: r.erro, osUsada: os.numero };
}

module.exports = {
  EVENTOS, EVENTOS_VALIDOS, CANAIS, CANAIS_VALIDOS, PLACEHOLDERS,
  migrarNotificacoesDB, dispatchNotificacoes, enviarTeste, registrarLog,
};
