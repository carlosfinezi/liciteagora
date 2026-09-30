/**
 * wa-numeros.js — os números que não têm WhatsApp.
 *
 * Na campanha 3 do 1bit (29/09), 10 de 22 envios falharam porque o número não
 * tem WhatsApp, e nada guardava isso: a próxima campanha tentaria de novo, e
 * cada tentativa ocupava um intervalo do ritmo de envio. Decidido em 29/09:
 *
 * - a marca é do NÚMERO (normalizado), e não da ficha: o mesmo telefone pode
 *   estar em mais de uma ficha, ou num contato sem ficha;
 * - marca quem a Evolution disse que não existe, seja numa falha de envio
 *   ("exists": false), seja na verificação de uma lista;
 * - as campanhas, nova e legado, pulam o número marcado, com o motivo;
 * - a ficha mostra a marca e a desfaz.
 *
 * A verificação de uma lista consulta a Evolution em lotes pequenos, com pausa
 * entre eles, em segundo plano: consultar 15 mil números de uma vez pode chamar
 * a atenção do WhatsApp para o número da empresa. Número verificado nos últimos
 * 30 dias não é consultado de novo, e por isso uma verificação interrompida por
 * restart continua de onde parou ao ser pedida outra vez.
 */
'use strict';

const LOTE = 25;
const PAUSA_MS = 3000;
const VALIDADE_DIAS = 30;

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_numeros (
      destino TEXT PRIMARY KEY,
      existe INTEGER NOT NULL,
      verificadoEm TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      origem TEXT
    );
    CREATE TABLE IF NOT EXISTS wa_verificacoes (
      listaId INTEGER PRIMARY KEY,
      estado TEXT NOT NULL,
      total INTEGER DEFAULT 0,
      feitos INTEGER DEFAULT 0,
      semWhatsapp INTEGER DEFAULT 0,
      erro TEXT,
      inicio TEXT,
      fim TEXT
    );
  `);
}

const temTabela = (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wa_numeros'").get();

/** O número (normalizado) está marcado como sem WhatsApp? */
function semWhatsapp(db, destino) {
  try { return !!db.prepare('SELECT 1 FROM wa_numeros WHERE destino = ? AND existe = 0').get(destino); }
  catch (_) { return false; }
}

function gravar(db, destino, existe, origem) {
  if (!temTabela(db)) migrar(db);
  db.prepare(`INSERT INTO wa_numeros (destino, existe, origem, verificadoEm)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(destino) DO UPDATE SET existe = excluded.existe, origem = excluded.origem,
      verificadoEm = excluded.verificadoEm`).run(destino, existe ? 1 : 0, origem || null);
}

/** Uma falha de envio em que a Evolution disse que o número não existe. */
const erroDeNumeroInexistente = (erro) => /"exists"\s*:\s*false/.test(String(erro || ''));

/** Marca o número se o erro do envio diz que ele não tem WhatsApp. Devolve se marcou. */
function marcarPelaFalha(db, destino, erro) {
  if (!destino || !erroDeNumeroInexistente(erro)) return false;
  try { gravar(db, destino, false, 'falha de envio'); return true; } catch (_) { return false; }
}

/** Tira a marca (a pessoa passou a ter WhatsApp, ou a marca estava errada). */
function desfazer(db, destino) {
  try { return db.prepare('DELETE FROM wa_numeros WHERE destino = ?').run(destino).changes; }
  catch (_) { return 0; }
}

/** Consulta um lote na Evolution: Map número → true/false. */
async function consultar(db, numeros, { buscar = fetch } = {}) {
  const canal = require('./whatsapp-canais').canalPadrao(db);
  const base = String((canal && canal.baseUrl) || process.env.EVOLUTION_URL || '').replace(/\/$/, '');
  const apikey = (canal && canal.apikey) || process.env.EVOLUTION_APIKEY || '';
  if (!base || !canal || !canal.instance) throw new Error('A empresa não tem número de WhatsApp conectado');
  const r = await buscar(`${base}/chat/whatsappNumbers/${encodeURIComponent(canal.instance)}`, {
    method: 'POST', headers: { apikey, 'content-type': 'application/json' },
    body: JSON.stringify({ numbers: numeros }), signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error(`A Evolution recusou a consulta (http ${r.status})`);
  const res = new Map();
  for (const x of j) {
    const n = String(x.number || (x.jid || '').split('@')[0]).replace(/\D/g, '');
    if (n) res.set(n, !!x.exists);
  }
  return res;
}

/** Os números da lista (normalizados, sem repetir) que precisam de consulta. */
function numerosDaLista(db, listaId) {
  const { normalizarDestino } = require('./comm-destinos');
  const todos = new Set();
  for (const m of db.prepare(`SELECT COALESCE(p.telefone, m.destinoManual) AS tel FROM comm_lista_membros m
      LEFT JOIN pessoas p ON p.id = m.pessoaId WHERE m.listaId = ?`).all(listaId)) {
    const d = normalizarDestino('whatsapp', m.tel);
    if (d) todos.add(d);
  }
  const recentes = new Set(db.prepare(`SELECT destino FROM wa_numeros
    WHERE verificadoEm > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`).all(`-${VALIDADE_DIAS} days`).map(r => r.destino));
  return [...todos].filter(d => !recentes.has(d));
}

// Verificações em andamento neste processo: `${slug}:${listaId}`.
const rodando = new Map();

function situacao(db, listaId) {
  try { return db.prepare('SELECT * FROM wa_verificacoes WHERE listaId = ?').get(listaId) || null; }
  catch (_) { return null; }
}

/**
 * Começa a verificar a lista em segundo plano e devolve a situação inicial.
 * Já rodando neste processo, não começa outra.
 */
function verificarLista(db, slug, listaId, { buscar = fetch, pausaMs = PAUSA_MS, lote = LOTE } = {}) {
  migrar(db);
  const chave = `${slug}:${listaId}`;
  if (rodando.has(chave)) return { ...situacao(db, listaId), jaRodando: true };
  const pendentes = numerosDaLista(db, listaId);
  db.prepare(`INSERT INTO wa_verificacoes (listaId, estado, total, feitos, semWhatsapp, erro, inicio, fim)
      VALUES (?, 'rodando', ?, 0, 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL)
    ON CONFLICT(listaId) DO UPDATE SET estado = 'rodando', total = excluded.total, feitos = 0, semWhatsapp = 0,
      erro = NULL, inicio = excluded.inicio, fim = NULL`).run(listaId, pendentes.length);
  const trabalho = (async () => {
    let feitos = 0, sem = 0;
    try {
      for (let i = 0; i < pendentes.length; i += lote) {
        const pedaco = pendentes.slice(i, i + lote);
        const res = await consultar(db, pedaco, { buscar });
        db.transaction(() => {
          for (const d of pedaco) {
            // Número que a Evolution não devolveu fica sem marca: na dúvida, envia.
            if (!res.has(d)) continue;
            gravar(db, d, res.get(d), 'verificação da lista');
            if (!res.get(d)) sem++;
          }
        })();
        feitos += pedaco.length;
        db.prepare('UPDATE wa_verificacoes SET feitos = ?, semWhatsapp = ? WHERE listaId = ?').run(feitos, sem, listaId);
        if (i + lote < pendentes.length) await new Promise(r => setTimeout(r, pausaMs));
      }
      db.prepare(`UPDATE wa_verificacoes SET estado = 'concluida', fim = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE listaId = ?`).run(listaId);
    } catch (e) {
      db.prepare(`UPDATE wa_verificacoes SET estado = 'parou', erro = ?, fim = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE listaId = ?`).run(String(e.message).slice(0, 300), listaId);
    } finally { rodando.delete(chave); }
  })();
  rodando.set(chave, trabalho);
  return { ...situacao(db, listaId), trabalho };
}

module.exports = {
  migrar, semWhatsapp, gravar, marcarPelaFalha, erroDeNumeroInexistente, desfazer, consultar,
  numerosDaLista, verificarLista, situacao, rodando, LOTE, PAUSA_MS,
};
