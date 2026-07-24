/**
 * habilitacao-provedores/cndfed.js — provider da CND Federal conjunta
 * (Receita Federal + PGFN). Wrapper do robô `cndfed-emitir.js` (Chrome+NopeCHA
 * no site público servicos.receitafederal.gov.br). Sem login, sem proxy.
 *
 * Se a empresa tiver pendência fiscal federal, o robô devolve erro claro
 * ("023 - provável pendência fiscal") — não há certidão negativa a emitir.
 */
const path = require('path');
const { spawn } = require('child_process');

const { enfileirar } = require('../habilitacao-fila');

const ROBO = path.join(__dirname, '..', 'cndfed-emitir.js');
const TIMEOUT_MS = 5 * 60 * 1000;

async function buscar(doc, { tenantSlug, cnpjCtx }) {
  if (!tenantSlug) throw new Error('tenant não identificado');
  return enfileirar(async () => {
    const env = { ...process.env, TENANT: tenantSlug, DOC_ID: String(doc.id), HOME: process.env.HOME || '/home/carlosfinezi' };
    // Multi-loja: CNPJ do estabelecimento (CND Federal é federal → herda da matriz p/ filial).
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

module.exports = { buscar };
