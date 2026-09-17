/**
 * habilitacao-provedores/cndfed.js — provider da CND Federal conjunta
 * (Receita Federal + PGFN).
 *
 * ─── MOTOR: O LICITEAGORA BROWSER DO CLIENTE, NÃO O SERVIDOR ────────────────
 *
 * Este provider NÃO emite mais aqui. Ele enfileira o pedido em `certidao-ponte`
 * e espera o LiciteAgora Browser (>= 6.3.0) da máquina do cliente emitir e
 * devolver o PDF.
 *
 * Por quê: o robô local (`cndfed-emitir.js`, Puppeteer sob xvfb) nunca emitiu —
 * 023/106 em TODAS as combinações de perfil × IP medidas em 03/08 e 03/09/2026,
 * inclusive com SOCKS residencial. O Chrome instalado na máquina do usuário, com
 * perfil persistente e aquecido, emitiu 12 de 12. A variável decisiva é o perfil
 * do navegador, não o IP nem a biblioteca de automação.
 *
 * ─── CONSEQUÊNCIA OPERACIONAL (dizer, não esconder) ─────────────────────────
 *
 * A emissão depende de o desktop do cliente estar ligado com o Browser aberto.
 * Se ninguém atender em 10 min, o pedido falha com mensagem explícita. Isso vale
 * para o botão da tela E para a renovação diária: se o cron roda de madrugada
 * com o PC desligado, não emite naquele dia.
 *
 * `CNDFED_MOTOR=servidor` volta ao robô antigo (o que não funciona) — existe só
 * para permitir remedir a hipótese sem editar código.
 */
const path = require('path');
const { spawn } = require('child_process');

const { enfileirar } = require('../habilitacao-fila');
const ponte = require('../certidao-ponte');

const ROBO = path.join(__dirname, '..', 'cndfed-emitir.js');
const TIMEOUT_MS = 5 * 60 * 1000;

// ─── caminho novo: pedido ao Browser do cliente ─────────────────────────────

// A fila precisa de conexão GRAVÁVEL ao banco do tenant, e nem sempre chega uma:
// a renovação diária (`habilitacao-renovar.js:110`) abre o banco em readonly, lê
// os documentos e FECHA antes de chamar o provider — passa só `tenantSlug`. Por
// isso resolvemos a conexão aqui, do mesmo jeito nos dois chamadores.
function abrirTenant(tenantSlug, dbDoCtx) {
  const arq = path.join(__dirname, '..', 'data', 'tenants', tenantSlug, 'pncp.db');
  try {
    const fs = require('fs');
    if (fs.existsSync(arq)) {
      const Database = require('better-sqlite3');
      return { db: new Database(arq), fechar: true };
    }
  } catch (_) { /* cai no db do contexto */ }
  if (dbDoCtx) return { db: dbDoCtx, fechar: false };
  throw new Error(`banco do tenant ${tenantSlug} não encontrado`);
}

async function viaBrowserDoCliente(doc, { db, tenantSlug, cnpjCtx }) {
  const cnpj = cnpjCtx && cnpjCtx.cnpj ? String(cnpjCtx.cnpj) : null;
  if (!cnpj) throw new Error('CNPJ do estabelecimento não encontrado');

  const { db: tdb, fechar } = abrirTenant(tenantSlug, db);
  try {
    // Reaproveitar em vez de duplicar: dois cliques no botão viravam duas
    // emissões do mesmo documento, e rajada na Receita responde 106.
    const { id, reaproveitado } = ponte.enfileirar(tdb, { docId: doc.id, cnpj, origem: 'manual' });
    const resultado = await ponte.aguardar(tdb, id);
    return {
      mensagem: `CND Federal emitida pelo LiciteAgora Browser — válida até ${resultado.dataValidade}` +
                (reaproveitado ? ' (pedido já estava em andamento)' : ''),
      resultado,
    };
  } finally {
    if (fechar) { try { tdb.close(); } catch (_) {} }
  }
}

// ─── caminho antigo: robô no servidor (não funciona; mantido por medição) ───

async function viaServidor(doc, { tenantSlug, cnpjCtx }) {
  return enfileirar(async () => {
    const env = { ...process.env, TENANT: tenantSlug, DOC_ID: String(doc.id), HOME: process.env.HOME || '/home/carlosfinezi' };
    if (cnpjCtx && cnpjCtx.cnpj) env.CNPJ = String(cnpjCtx.cnpj).replace(/\D/g, '');
    const resultado = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/xvfb-run', ['-a', process.execPath, ROBO], { env, cwd: path.join(__dirname, '..') });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout na emissão CND Federal (5min)')); }, TIMEOUT_MS);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', () => {
        clearTimeout(timer);
        const m = out.match(/__RESULT__ (\{[\s\S]*\})/);
        if (!m) return reject(new Error('robô CND Federal não retornou resultado'));
        let r; try { r = JSON.parse(m[1]); } catch (e) { return reject(new Error('resultado inválido do robô')); }
        if (!r.ok) return reject(new Error(r.error || 'falha na emissão CND Federal'));
        resolve(r);
      });
    });
    return { mensagem: `CND Federal emitida — válida até ${resultado.dataValidade}`, resultado };
  }, { label: `CND-Federal ${tenantSlug} doc ${doc.id}` });
}

async function buscar(doc, ctx) {
  if (!ctx || !ctx.tenantSlug) throw new Error('tenant não identificado');
  if (process.env.CNDFED_MOTOR === 'servidor') return viaServidor(doc, ctx);
  return viaBrowserDoCliente(doc, ctx);
}

module.exports = { buscar };
