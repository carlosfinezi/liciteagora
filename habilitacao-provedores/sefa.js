/**
 * habilitacao-provedores/sefa.js — provider da Certidão Negativa Estadual
 * (SEFA-PA). Wrapper do robô `sefa-emitir.js` (Struts, SEM captcha, mas
 * datacenter bloqueado → via SOCKS residencial). Emite por Inscrição Estadual.
 */
const path = require('path');
const { spawn } = require('child_process');

const { enfileirar } = require('../habilitacao-fila');

const ROBO = path.join(__dirname, '..', 'sefa-emitir.js');
const TIMEOUT_MS = 5 * 60 * 1000;

async function buscar(doc, { tenantSlug, cnpjCtx }) {
  if (!tenantSlug) throw new Error('tenant não identificado');
  return enfileirar(async () => {
    const env = { ...process.env, TENANT: tenantSlug, DOC_ID: String(doc.id), HOME: process.env.HOME || '/home/carlosfinezi' };
    // Multi-loja: estadual é por estabelecimento → IE e CNPJ próprios da filial.
    if (cnpjCtx && cnpjCtx.inscricaoEstadual) env.IE = String(cnpjCtx.inscricaoEstadual).replace(/\D/g, '');
    if (cnpjCtx && cnpjCtx.cnpj) env.CNPJ = String(cnpjCtx.cnpj).replace(/\D/g, '');
    const resultado = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/xvfb-run', ['-a', process.execPath, ROBO], { env, cwd: path.join(__dirname, '..') });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout na emissão estadual (5min)')); }, TIMEOUT_MS);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', () => {
        clearTimeout(timer);
        const m = out.match(/__RESULT__ (\{[\s\S]*\})/);
        if (!m) return reject(new Error('robô SEFA-PA não retornou resultado'));
        let r; try { r = JSON.parse(m[1]); } catch (e) { return reject(new Error('resultado inválido do robô')); }
        if (!r.ok) return reject(new Error(r.error || 'falha na emissão estadual'));
        resolve(r);
      });
    });
    return { mensagem: `Certidão Estadual (SEFA-PA) emitida — válida até ${resultado.dataValidade}`, resultado };
  }, { label: `Estadual ${tenantSlug} doc ${doc.id}` });
}

module.exports = { buscar };
