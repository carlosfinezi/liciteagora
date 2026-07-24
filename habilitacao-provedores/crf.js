/**
 * habilitacao-provedores/crf.js — provider de busca automática do CRF FGTS.
 *
 * Wrapper do robô `crf-emitir.js` (Chrome hardened + SOCKS residencial p/
 * passar o ShieldSquare da Caixa). Rodado como processo filho sob xvfb-run,
 * com PROXY apontando pro SOCKS da VPN "loja". Relata o resultado.
 */
const path = require('path');
const { spawn } = require('child_process');

const { enfileirar } = require('../habilitacao-fila');

const ROBO = path.join(__dirname, '..', 'crf-emitir.js');
const TIMEOUT_MS = 6 * 60 * 1000;
const PROXY = process.env.CRF_PROXY || 'socks5://127.0.0.1:1080';

async function buscar(doc, { tenantSlug, cnpjCtx }) {
  if (!tenantSlug) throw new Error('tenant não identificado');
  return enfileirar(async () => {
    const env = {
      ...process.env,
      TENANT: tenantSlug,
      DOC_ID: String(doc.id),
      PROXY,
      HOME: process.env.HOME || '/home/carlosfinezi',
    };
    // Multi-loja: CNPJ do estabelecimento (FGTS é federal → herda da matriz p/ filial).
    if (cnpjCtx && cnpjCtx.cnpj) env.CNPJ = String(cnpjCtx.cnpj).replace(/\D/g, '');
    const resultado = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/xvfb-run', ['-a', process.execPath, ROBO], { env, cwd: path.join(__dirname, '..') });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout na emissão CRF (6min)')); }, TIMEOUT_MS);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', () => {
        clearTimeout(timer);
        const m = out.match(/__RESULT__ (\{[\s\S]*\})/);
        if (!m) return reject(new Error('robô CRF não retornou resultado'));
        let r; try { r = JSON.parse(m[1]); } catch (e) { return reject(new Error('resultado inválido do robô')); }
        if (!r.ok) return reject(new Error(r.error || 'falha na emissão CRF'));
        resolve(r);
      });
    });
    const sit = resultado.regular === false ? 'IRREGULAR' : 'regular';
    return { mensagem: `CRF FGTS (${sit}) emitido — válido até ${resultado.dataValidade}`, resultado };
  }, { label: `CRF ${tenantSlug} doc ${doc.id}` });
}

module.exports = { buscar };
