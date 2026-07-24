/**
 * cobranca-scheduler.js — Agendador diario da régua de cobranças.
 *
 * Roda 1x por dia (horaExecucao BRT, default 9h). Pula sáb/dom/feriado
 * se executarDiasUteis=true. Chama executarRegua() em cobrancas-routes.
 */

const { executarRegua, getConfig, isDiaUtil, dataBrasilia } = require('./cobrancas-routes');

// Multi-tenant: um timeout + flag de execução por instância de db. Antes
// eram `let` globais, o que fazia cada chamada de agendarCobrancas(db)
// cancelar o agendamento do tenant anterior.
const timeoutRefs = new Map();
const executandoMap = new Map();

function agendarCobrancas(db) {
  const existing = timeoutRefs.get(db);
  if (existing) {
    clearTimeout(existing);
    timeoutRefs.delete(db);
  }

  const cfg = getConfig(db);
  const horaBrt = typeof cfg.horaExecucao === 'number' ? cfg.horaExecucao : 9;

  const agora = new Date();
  const proxima = new Date();
  proxima.setUTCHours(horaBrt + 3, 0, 0, 0); // BRT -> UTC
  if (proxima <= agora) {
    proxima.setDate(proxima.getDate() + 1);
  }

  const ms = proxima.getTime() - agora.getTime();
  const brt = new Date(proxima.getTime() - 3 * 60 * 60 * 1000);
  console.log(`[Cobrancas] Proximo check: ${brt.toISOString().replace('T',' ').substring(0,19)} BRT`);

  const timer = setTimeout(async () => {
    try {
      const hoje = dataBrasilia();
      const cfgAtual = getConfig(db);
      const deveExecutar = !cfgAtual.executarDiasUteis || isDiaUtil(hoje);

      if (!deveExecutar) {
        console.log(`[Cobrancas] ${hoje} nao e dia util — pulando`);
      } else if (executandoMap.get(db)) {
        console.log(`[Cobrancas] Execucao anterior ainda rodando — pulando`);
      } else {
        executandoMap.set(db, true);
        try {
          const r = await executarRegua(db, { dryRun: false });
          console.log(`[Cobrancas] Executou regua: ${r.total} contas processadas`);
        } catch (err) {
          console.error('[Cobrancas] Erro ao executar regua:', err.message);
        } finally {
          executandoMap.set(db, false);
        }
      }
    } finally {
      agendarCobrancas(db);
    }
  }, ms);
  timeoutRefs.set(db, timer);
}

module.exports = { agendarCobrancas };
