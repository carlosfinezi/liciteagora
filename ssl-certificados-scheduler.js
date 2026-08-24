/**
 * ssl-certificados-scheduler.js — o relógio do ciclo de vida SSL da NicSRS.
 *
 * Roda no processo master (scheduler.js), uma passada por tenant. Quatro
 * tarefas, nesta ordem:
 *
 *   1. collect  — certificados em 'comprado'/'reemitindo' viram 'emitido'
 *                 quando a CA termina de validar.
 *   2. reissue  — o coração do módulo. O arquivo vale ~200 dias, a assinatura
 *                 vale 1+ ano: quando o arquivo está perto de expirar e ainda
 *                 há cobertura, reemite. É gratuito, por isso é automático.
 *   3. expirado — assinatura que passou de cobertoAte sai do radar.
 *   4. alerta   — assinatura vencendo em 90/30/7 dias avisa uma vez por marco.
 *                 A RECOMPRA continua manual: gasta saldo.
 *
 * Inerte enquanto o tenant não tiver config['nicsrs_api_token'].
 */

const nicsrs = require('./nicsrs-client');
const { enviarAlerta } = require('./notificacoes-dispatcher');
const {
  migrarDB, aplicarCollect, registrarEvento, getConfig, hojeIso,
} = require('./ssl-certificados-routes');

const MARCOS_ALERTA = [90, 30, 7];

function tokenDoTenant(db) {
  try {
    return getConfig(db, 'nicsrs_api_token');
  } catch {
    return null;
  }
}

/** 1. Puxa status de quem está em andamento. */
async function sincronizarPendentes(db, token, slug) {
  const pendentes = db.prepare(`
    SELECT * FROM ssl_certificados
    WHERE certId IS NOT NULL AND status IN ('comprado','reemitindo')
  `).all();
  let emitidos = 0;
  for (const cert of pendentes) {
    try {
      const resposta = await nicsrs.collect(token, cert.certId);
      const aplicado = aplicarCollect(db, cert, resposta);
      if (aplicado.status !== cert.status) {
        registrarEvento(db, cert.id, 'status', `Status ${cert.status} → ${aplicado.status}`, aplicado, 'scheduler');
        if (aplicado.status === 'emitido') emitidos++;
      }
    } catch (err) {
      db.prepare('UPDATE ssl_certificados SET ultimoErro = ? WHERE id = ?').run(err.message, cert.id);
      console.error(`[master][${slug}] ssl collect #${cert.id}:`, err.message);
    }
  }
  return emitidos;
}

/** 2. Reemite o que está perto de vencer e ainda tem assinatura cobrindo. */
async function reemitirVencendo(db, token, slug) {
  if (getConfig(db, 'nicsrs_reissue_automatico', '1') !== '1') return 0;
  const hoje = hojeIso();
  const alvos = db.prepare(`
    SELECT * FROM ssl_certificados
    WHERE status = 'emitido' AND proximoReissueEm IS NOT NULL
      AND date(proximoReissueEm) <= date(?)
      AND cobertoAte IS NOT NULL AND date(endDate) < date(cobertoAte)
  `).all(hoje);
  let feitos = 0;
  for (const cert of alvos) {
    try {
      const resposta = await nicsrs.reissue(token, {
        certId: cert.certId,
        reason: `Reemissao automatica: arquivo expira em ${cert.endDate}, assinatura vai ate ${cert.cobertoAte}`,
        uniqueValue: cert.uniqueValue || undefined,
        refId: `${cert.refId || cert.id}-R${cert.reissuesFeitos + 1}`,
      });
      const novoCertId = resposta.data && resposta.data.certId ? String(resposta.data.certId) : cert.certId;
      db.prepare(`
        UPDATE ssl_certificados SET
          certId = ?, status = 'reemitindo', statusNicsrs = 'PENDING',
          reissuesFeitos = reissuesFeitos + 1, proximoReissueEm = NULL,
          ultimoErro = NULL, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(novoCertId, cert.id);
      registrarEvento(db, cert.id, 'reissue', `Reemissão automática (certId ${novoCertId})`, null, 'scheduler');
      feitos++;

      // DCV por e-mail exige o cliente clicar num link — não é silencioso.
      if (cert.dcvMethod === 'EMAIL') {
        await enviarAlerta(db, {
          subject: `SSL ${cert.commonName}: reemissão exige aprovação por e-mail`,
          body: `A reemissão automática de ${cert.commonName} foi disparada, mas o método de validação é EMAIL: ${cert.dcvEmail || 'destinatário não informado'} precisa aprovar o link da CA para o certificado sair.`,
          logTag: 'SSL',
        }).catch(() => {});
      }
    } catch (err) {
      db.prepare('UPDATE ssl_certificados SET ultimoErro = ? WHERE id = ?').run(err.message, cert.id);
      registrarEvento(db, cert.id, 'erro-reissue', err.message, null, 'scheduler');
      console.error(`[master][${slug}] ssl reissue #${cert.id}:`, err.message);
    }
  }
  return feitos;
}

/** 3. Assinatura terminada. */
function marcarExpirados(db) {
  const r = db.prepare(`
    UPDATE ssl_certificados
    SET status = 'expirado', proximoReissueEm = NULL, dataAtualizacao = CURRENT_TIMESTAMP
    WHERE status IN ('emitido','comprado') AND cobertoAte IS NOT NULL AND date(cobertoAte) < date('now')
  `).run();
  return r.changes;
}

/** 4. Aviso de assinatura vencendo — uma vez por marco, nunca recompra sozinho. */
async function alertarRenovacoes(db) {
  let enviados = 0;
  for (const dias of MARCOS_ALERTA) {
    const alvos = db.prepare(`
      SELECT s.*, c.numero AS contratoNumero, c.status AS contratoStatus
      FROM ssl_certificados s
      LEFT JOIN contratos c ON c.id = s.contratoId
      WHERE s.status IN ('emitido','comprado') AND s.cobertoAte IS NOT NULL
        AND date(s.cobertoAte) <= date('now', '+' || ? || ' days')
        AND date(s.cobertoAte) >= date('now')
        AND NOT EXISTS (
          SELECT 1 FROM ssl_certificados_eventos e
          WHERE e.certificadoId = s.id AND e.tipo = ?
        )
    `).all(dias, `alerta-${dias}d`);

    for (const cert of alvos) {
      const contrato = cert.contratoNumero
        ? `contrato ${cert.contratoNumero} (${cert.contratoStatus})`
        : 'sem contrato vinculado';
      await enviarAlerta(db, {
        subject: `SSL ${cert.commonName}: assinatura vence em ${dias} dia(s)`,
        body: `A assinatura NicSRS de ${cert.commonName} vai até ${cert.cobertoAte} — ${contrato}. Depois dessa data não há mais reemissão gratuita: é preciso recomprar ou renovar na fila de aprovação.`,
        logTag: 'SSL',
      }).catch(() => {});
      registrarEvento(db, cert.id, `alerta-${dias}d`, `Aviso de vencimento da assinatura (${dias} dias)`, null, 'scheduler');
      enviados++;
    }
  }
  return enviados;
}

/** Passada completa em um tenant. Devolve o resumo do que mudou. */
async function varrerTenant(db, slug = '?') {
  migrarDB(db);
  const token = tokenDoTenant(db);
  if (!token) return null;

  const emitidos = await sincronizarPendentes(db, token, slug);
  const reemitidos = await reemitirVencendo(db, token, slug);
  const expirados = marcarExpirados(db);
  const alertas = await alertarRenovacoes(db);
  return { emitidos, reemitidos, expirados, alertas };
}

module.exports = {
  varrerTenant,
  sincronizarPendentes,
  reemitirVencendo,
  marcarExpirados,
  alertarRenovacoes,
  MARCOS_ALERTA,
};
