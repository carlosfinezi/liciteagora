/**
 * habilitacao-provedores/cndt.js — provider de busca automática da CNDT (TST).
 *
 * Faz o wrapper do robô de navegador `cndt-emitir.js` (Chrome+xvfb+OCR), que
 * é rodado como processo filho sob xvfb-run (o serviço web não tem DISPLAY).
 * O robô emite a certidão, baixa o PDF e grava tudo no documento (DOC_ID).
 * Aqui só disparamos e relatamos o resultado (linha `__RESULT__ {...}`).
 */

const path = require('path');
const { spawn } = require('child_process');

const { enfileirar } = require('../habilitacao-fila');

const ROBO = path.join(__dirname, '..', 'cndt-emitir.js');
const TIMEOUT_MS = 5 * 60 * 1000;

async function buscar(doc, { tenantSlug, cnpjCtx }) {
  if (!tenantSlug) throw new Error('tenant não identificado');
  return enfileirar(async () => {
    const env = {
      ...process.env,
      TENANT: tenantSlug,
      DOC_ID: String(doc.id),
      HOME: process.env.HOME || '/home/carlosfinezi',
    };
    // Multi-loja: CNPJ do estabelecimento (com herança matriz p/ federal).
    if (cnpjCtx && cnpjCtx.cnpj) env.CNPJ = String(cnpjCtx.cnpj).replace(/\D/g, '');
    const resultado = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/xvfb-run', ['-a', process.execPath, ROBO],
        { env, cwd: path.join(__dirname, '..') });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout na emissão CNDT (5min)')); }, TIMEOUT_MS);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', () => {
        clearTimeout(timer);
        const m = out.match(/__RESULT__ (\{[\s\S]*\})/);
        if (!m) return reject(new Error('robô CNDT não retornou resultado'));
        let r; try { r = JSON.parse(m[1]); } catch (e) { return reject(new Error('resultado inválido do robô')); }
        if (!r.ok) return reject(new Error(r.error || 'falha na emissão CNDT'));
        resolve(r);
      });
    });
    const tipo = resultado.negativa === false ? 'POSITIVA (há débitos)' : 'negativa';
    return { mensagem: `CNDT ${tipo} emitida — válida até ${resultado.dataValidade}`, resultado };
  }, { label: `CNDT ${tenantSlug} doc ${doc.id}` });
}

module.exports = { buscar };
