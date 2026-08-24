/**
 * governanca-avisos.js — quem precisa saber que uma aprovação está esperando.
 *
 * A alçada bloqueia o pagamento e cria uma solicitação. Até 2026-08-02 esse
 * era o fim do assunto: a solicitação ficava numa fila dentro de
 * Configurações → Alçadas, sem link a partir de Contas a Pagar ou Pedidos de
 * Compra, sem contador, sem aviso. Quem aprova só descobria se abrisse a
 * página por conta própria — e ninguém abre uma tela de configuração todo dia.
 *
 * São dois momentos, e só dois, para não virar ruído:
 *   1. quando a solicitação nasce;
 *   2. quando está perto de vencer (a aprovação expira e o pedido tem de ser
 *      refeito do zero).
 *
 * Cada um dispara UMA vez por aprovação. O controle de "já avisei" fica em
 * colunas da própria linha: repetir todo dia treinaria o aprovador a ignorar.
 */

'use strict';

const DIA = 86400000;

/** Data local (BRT) em ISO curto — o resto do módulo de alçadas usa o mesmo. */
const hojeBRT = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

function migrarAvisosDB(db) {
  const cols = db.prepare('PRAGMA table_info(aprovacoes)').all().map((c) => c.name);
  if (!cols.includes('avisoCriacaoEm')) {
    db.exec('ALTER TABLE aprovacoes ADD COLUMN avisoCriacaoEm TEXT');
  }
  if (!cols.includes('avisoExpiracaoEm')) {
    db.exec('ALTER TABLE aprovacoes ADD COLUMN avisoExpiracaoEm TEXT');
  }
}

const EVENTO_TXT = {
  pagamento_cp: 'Pagamento de conta a pagar',
  pedido_compra: 'Envio de pedido de compra',
};

const moeda = (v) => `R$ ${(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dataBR = (d) => {
  const s = String(d || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || '—');
};

/**
 * Descrição legível da referência. Sem isso a mensagem diria "ref. 47", que
 * não ajuda ninguém a decidir sem abrir o sistema.
 */
function descreverReferencia(db, tipoEvento, referenciaId) {
  // O nome do fornecedor vive em `fornecedores`, não numa coluna de
  // contas_a_pagar — que só guarda `fornecedorId`. LEFT JOIN, não JOIN: conta
  // sem fornecedor amarrado continua tendo descrição, e é justamente numa
  // dessas que o aprovador mais precisa de contexto.
  try {
    if (tipoEvento === 'pagamento_cp') {
      const c = db.prepare(`SELECT c.descricao,
          COALESCE(f.nomeFantasia, f.razaoSocial) AS fornecedor
        FROM contas_a_pagar c LEFT JOIN pessoas f ON f.id = c.fornecedorId
        WHERE c.id = ?`).get(referenciaId);
      if (c) return [c.fornecedor, c.descricao].filter(Boolean).join(' — ') || `conta #${referenciaId}`;
    }
    if (tipoEvento === 'pedido_compra') {
      const p = db.prepare(`SELECT p.numero,
          COALESCE(f.nomeFantasia, f.razaoSocial) AS fornecedor
        FROM pedidos_compra p LEFT JOIN pessoas f ON f.id = p.fornecedorId
        WHERE p.id = ?`).get(referenciaId);
      if (p) return [`pedido ${p.numero || referenciaId}`, p.fornecedor].filter(Boolean).join(' — ');
    }
  } catch { /* tabela ausente neste tenant */ }
  return `#${referenciaId}`;
}

/** Mensagem HTML (subset aceito pelo Telegram; o email envelopa). */
function mensagemDeAprovacao(db, a, { tipo = 'criada' } = {}) {
  const ref = descreverReferencia(db, a.tipoEvento, a.referenciaId);
  const cab = tipo === 'expirando'
    ? '⏳ <b>Aprovação prestes a vencer</b>'
    : '🛡️ <b>Aprovação pendente</b>';
  const linhas = [
    cab,
    EVENTO_TXT[a.tipoEvento] || a.tipoEvento,
    `${ref} — <b>${moeda(a.valorReferencia)}</b>`,
    `Solicitado por: ${a.solicitante || '—'}`,
    `Quem decide: <b>${a.papelExigido || 'admin'}</b>`,
  ];
  if (a.expiraEm) {
    linhas.push(tipo === 'expirando'
      ? `Vence em <b>${dataBR(a.expiraEm)}</b> — depois disso o pedido tem de ser refeito.`
      : `Válida até ${dataBR(a.expiraEm)}`);
  }
  linhas.push('', '<i>Decida em Aprovações.</i>');
  return linhas.join('\n');
}

const assuntoDeAprovacao = (a, tipo) =>
  `[LiciteAgora] ${tipo === 'expirando' ? '⏳ Aprovação vence' : '🛡️ Aprovação pendente'}`
  + ` — ${EVENTO_TXT[a.tipoEvento] || a.tipoEvento} ${moeda(a.valorReferencia)}`;

/**
 * Aprovações pendentes que vencem dentro de `diasAntes` e ainda não foram
 * avisadas. Já vencidas ficam de fora: avisar depois do fato não ajuda, e o
 * diagnóstico da tela já mostra as expiradas.
 */
function aprovacoesExpirando(db, { hoje = hojeBRT(), diasAntes = 1 } = {}) {
  const limite = new Date(new Date(hoje + 'T00:00:00Z').getTime() + diasAntes * DIA)
    .toISOString().slice(0, 10);
  try {
    // date(): `expiraEm` é gravado como '2026-08-03 00:00:00' (com hora), e
    // comparar isso como texto contra '2026-08-03' dá FALSO — a string com
    // hora é maior. O aviso sairia sempre um dia atrasado, quando a aprovação
    // já teria vencido. Normalizar os dois lados é o que torna a janela real.
    return db.prepare(`SELECT * FROM aprovacoes
      WHERE status = 'pendente' AND consumida = 0
        AND expiraEm IS NOT NULL
        AND date(expiraEm) >= date(?) AND date(expiraEm) <= date(?)
        AND avisoExpiracaoEm IS NULL
      ORDER BY expiraEm ASC`).all(hoje, limite);
  } catch { return []; }
}

const marcarAvisada = (db, id, coluna, quando = null) => {
  try {
    db.prepare(`UPDATE aprovacoes SET ${coluna} = ? WHERE id = ?`)
      .run(quando || new Date().toISOString(), id);
  } catch { /* coluna ausente: migração ainda não rodou */ }
};

/**
 * Avisa que uma solicitação nasceu. Chamado pelo hook de alçada.
 *
 * Fire-and-forget de propósito: o caller é a baixa de um pagamento, e uma
 * falha de Telegram não pode derrubar (nem atrasar) a resposta HTTP. A
 * marcação acontece antes do envio para que uma corrida entre duas
 * requisições não gere dois avisos.
 */
async function avisarCriacao(db, aprovacaoId, { despachar } = {}) {
  let a;
  try { a = db.prepare('SELECT * FROM aprovacoes WHERE id = ?').get(aprovacaoId); } catch { return null; }
  if (!a || a.avisoCriacaoEm) return null;
  marcarAvisada(db, a.id, 'avisoCriacaoEm');
  const enviar = despachar || require('./notificacoes-dispatcher').enviarAlerta;
  return enviar(db, {
    subject: assuntoDeAprovacao(a, 'criada'),
    body: mensagemDeAprovacao(db, a, { tipo: 'criada' }),
    logTag: 'Alcada',
  });
}

/** Varre o tenant e avisa o que está para vencer. Usado pelo scheduler. */
async function avisarExpirando(db, { hoje, diasAntes = 1, despachar } = {}) {
  const pendentes = aprovacoesExpirando(db, { hoje: hoje || hojeBRT(), diasAntes });
  const enviar = despachar || require('./notificacoes-dispatcher').enviarAlerta;
  let enviados = 0;
  for (const a of pendentes) {
    marcarAvisada(db, a.id, 'avisoExpiracaoEm');
    try {
      await enviar(db, {
        subject: assuntoDeAprovacao(a, 'expirando'),
        body: mensagemDeAprovacao(db, a, { tipo: 'expirando' }),
        logTag: 'Alcada',
      });
      enviados++;
    } catch (e) {
      console.error(`[Alcada] aviso de expiração #${a.id}: ${e.message}`);
    }
  }
  return { candidatas: pendentes.length, enviados };
}

module.exports = {
  migrarAvisosDB, avisarCriacao, avisarExpirando, aprovacoesExpirando,
  mensagemDeAprovacao, assuntoDeAprovacao, descreverReferencia, hojeBRT,
};
