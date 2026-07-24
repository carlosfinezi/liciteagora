/**
 * habilitacao-provedores/mrb.js — provider da Certidão Negativa Municipal
 * (Prefeitura de Marabá-PA, portal NotaControl). Wrapper do robô
 * `mrb-emitir.js` (SPA Angular, SEM captcha, SEM login, SEM proxy).
 */
const path = require('path');
const { spawn } = require('child_process');

const { enfileirar } = require('../habilitacao-fila');

const ROBO = path.join(__dirname, '..', 'mrb-emitir.js');
const TIMEOUT_MS = 5 * 60 * 1000;

async function buscar(doc, { tenantSlug, cnpjCtx }) {
  if (!tenantSlug) throw new Error('tenant não identificado');
  return enfileirar(async () => {
    const env = { ...process.env, TENANT: tenantSlug, DOC_ID: String(doc.id), HOME: process.env.HOME || '/home/carlosfinezi' };
    // Multi-loja: municipal é por estabelecimento → CNPJ, IM e cidade próprios da filial.
    if (cnpjCtx && cnpjCtx.cnpj) env.CNPJ = String(cnpjCtx.cnpj).replace(/\D/g, '');
    if (cnpjCtx && cnpjCtx.inscricaoMunicipal) env.IM = String(cnpjCtx.inscricaoMunicipal).replace(/\D/g, '');
    if (cnpjCtx && cnpjCtx.cidade) env.CIDADE = String(cnpjCtx.cidade);
    const resultado = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/xvfb-run', ['-a', process.execPath, ROBO], { env, cwd: path.join(__dirname, '..') });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout na emissão municipal (5min)')); }, TIMEOUT_MS);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', () => {
        clearTimeout(timer);
        const m = out.match(/__RESULT__ (\{[\s\S]*\})/);
        if (!m) return reject(new Error('robô Marabá não retornou resultado'));
        let r; try { r = JSON.parse(m[1]); } catch (e) { return reject(new Error('resultado inválido do robô')); }
        if (!r.ok) return reject(new Error(r.error || 'falha na emissão municipal'));
        resolve(r);
      });
    });
    return { mensagem: `Certidão Municipal emitida — válida até ${resultado.dataValidade}`, resultado };
  }, { label: `Municipal ${tenantSlug} doc ${doc.id}` });
}

module.exports = { buscar };
