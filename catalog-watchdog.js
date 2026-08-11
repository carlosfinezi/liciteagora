// catalog-watchdog.js — vigilância das engines de backfill do catálogo.
//
// Motivo (incidente de 2026-08-07): o resultados-backfill morreu calado. Uma
// rejeição escapou do ciclo, o timer não foi rearmado, o processo seguiu de pé
// e o log ficou mudo por 4 dias — descoberto por acaso. O `finally` que as
// engines ganharam fecha aquele modo de morte; isto aqui cobre o que sobra:
// engine que para de trabalhar sem morrer.
//
// Heartbeat: cada engine vigiada grava <nome>LastRun em catalog_sync_state a
// cada ciclo, INCLUSIVE quando não tem o que fazer (caminho de lote vazio). É
// isso que separa "parada" de "ociosa".
//
// Fora daqui, de propósito:
//   - fts-backfill: no-op sob CATALOG_BACKEND_PG=1 (o índice GIN do PG cobre).
//     Não grava heartbeat porque nem chega a rodar.
//   - marca-portal-backfill: não publica nada em catalog_sync_state. Vigiar
//     exigiria primeiro acrescentar o carimbo na engine.

'use strict';

const catalogPg = require('./catalog-pg');
const { sendTelegram } = require('./telegram-client');

const INTERVALO_CHECK_MS = 60 * 60 * 1000;  // confere de hora em hora
const COOLDOWN_MS = 6 * 60 * 60 * 1000;     // no máximo 1 alerta por engine a cada 6h

// limiteMs com folga grande de propósito: ciclo lento sob carga é normal, e
// alerta que grita à toa vira ruído ignorado — que foi o problema do alerta de
// "Comprasnet DEGRADADO" antes do fix de 29/07.
const ENGINES = [
  { nome: 'resultados-backfill', chave: 'resultadosBackfillLastRun', limiteMs: 30 * 60 * 1000 },
  { nome: 'marca-backfill',      chave: 'marcaBackfillLastRun',      limiteMs: 60 * 60 * 1000 },
];

const _ultimoAlerta = new Map();
let _timer = null;

async function _lerCarimbo(chave) {
  const r = await catalogPg.queryOne('SELECT "value" FROM catalog_sync_state WHERE "key"=$1', [chave]);
  return r && r.value ? new Date(r.value) : null;
}

async function _verificar(dbAlerta) {
  const agora = Date.now();

  for (const eng of ENGINES) {
    let carimbo;
    try {
      carimbo = await _lerCarimbo(eng.chave);
    } catch (err) {
      console.error(`[catalog-watchdog] falha ao ler ${eng.chave}: ${err.message}`);
      continue;
    }

    // Sem carimbo = engine nunca rodou neste backend. É ausência, não parada.
    if (!carimbo || isNaN(carimbo.getTime())) continue;

    const paradaMs = agora - carimbo.getTime();
    if (paradaMs <= eng.limiteMs) continue;

    const minutos = Math.round(paradaMs / 60000);
    const limiteMin = Math.round(eng.limiteMs / 60000);

    // Console SEMPRE, antes de qualquer cooldown: o alerta tem que existir no
    // server.log mesmo que o Telegram falhe. O watchdog do pncp-sync-scheduler
    // alerta num db sem telegram_config desde sempre — 372 falhas silenciosas
    // no log e nenhuma mensagem entregue.
    console.error(`[catalog-watchdog] ⚠️ ${eng.nome} sem ciclo há ${minutos} min (limite ${limiteMin} min) — último: ${carimbo.toISOString()}`);

    const ultimo = _ultimoAlerta.get(eng.nome) || 0;
    if (agora - ultimo < COOLDOWN_MS) continue;
    _ultimoAlerta.set(eng.nome, agora);

    if (!dbAlerta) continue;
    await sendTelegram(dbAlerta,
      `⚠️ <b>Engine do catálogo parada</b>\n\n` +
      `<b>${eng.nome}</b> sem ciclo há ${minutos} min (limite ${limiteMin}).\n` +
      `Último ciclo: ${carimbo.toISOString()}\n\n` +
      `O processo do master pode estar de pé — conferir server.log.`
    );
  }
}

function iniciarWatchdogCatalogo({ dbAlerta } = {}) {
  if (process.env.CATALOG_BACKEND_PG !== '1') {
    console.log('[catalog-watchdog] inativo (o catálogo vigiado é o do Postgres)');
    return;
  }

  // Primeira checagem só daqui a 1h, não no boot: as engines acabaram de
  // subir e o carimbo antigo ainda é o da encarnação anterior.
  _timer = setInterval(() => {
    _verificar(dbAlerta).catch(err => console.error('[catalog-watchdog] verificação falhou:', err.message));
  }, INTERVALO_CHECK_MS);

  console.log(`[catalog-watchdog] ativo — ${ENGINES.map(e => e.nome).join(', ')} (check 1x/h, alerta ${dbAlerta ? 'no Telegram + log' : 'só no log'})`);
}

function pararWatchdogCatalogo() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { iniciarWatchdogCatalogo, pararWatchdogCatalogo };
