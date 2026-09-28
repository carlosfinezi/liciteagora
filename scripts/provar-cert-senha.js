#!/usr/bin/env node
// Prova, num tenant real, que a senha do certificado A1 está cifrada e que a
// NF-e continua assinando. Somente leitura: abre o pncp.db com readonly e usa
// a consulta de status da SEFAZ (mTLS com o certificado, sem gerar documento).
//
//   node scripts/provar-cert-senha.js 1bit produtosbomgosto
//
// Para cada tenant imprime: o formato gravado, se o banco sozinho revela a
// senha (base64 do valor gravado abre o pfx?), se a chave abre, o hash curto
// da senha (para comparar antes e depois sem mostrá-la) e o cStat da SEFAZ.

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const forge = require('node-forge');
const { decifrarSenha, cifrada } = require('../cert-senha');

const abre = (pfxB64, senha) => {
  try {
    forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(Buffer.from(pfxB64, 'base64').toString('binary')), senha);
    return true;
  } catch { return false; }
};

(async () => {
  let falhas = 0;
  for (const slug of process.argv.slice(2)) {
    const db = new Database(path.join(__dirname, '..', 'data', 'tenants', slug, 'pncp.db'), { readonly: true, fileMustExist: true });
    const c = db.prepare('SELECT certificadoBase64, senhaCriptografada FROM certificado_digital WHERE id = 1').get();
    if (!c) { console.log(`${slug}: sem certificado`); db.close(); continue; }
    const formato = cifrada(c.senhaCriptografada) ? 'cifrada (v1)' : 'base64 (antigo)';
    const soBanco = abre(c.certificadoBase64, Buffer.from(c.senhaCriptografada, 'base64').toString('utf8'));
    let senha = null;
    try { senha = decifrarSenha(c.senhaCriptografada, c.certificadoBase64); } catch (e) { console.log(`${slug}: decifra falhou: ${e.message}`); }
    const hash = senha == null ? '-' : crypto.createHash('sha256').update(senha).digest('hex').slice(0, 12);
    // Status com a UF real do emitente: o getTools de produção roteia o PA
    // como "SVRS", que a lib não sabe converter em cUF, e o sefazStatus dele
    // quebra na validação do próprio pedido (defeito anterior, fora daqui).
    // Qualquer cStat devolvido prova o TLS mútuo com o certificado aberto.
    const { Tools } = await import('node-sped-nfe');
    const { carregarEmitente } = require('../nfe-emit-routes');
    const status = async (senhaUsada) => {
      try {
        const cfg = db.prepare('SELECT tpAmb FROM nfe_config WHERE id = 1').get();
        const f = carregarEmitente(db);
        const t = new Tools({ mod: '55', tpAmb: cfg.tpAmb, UF: f.uf, versao: '4.00', CNPJ: f.cnpj.replace(/\D/g, '') },
          { pfx: Buffer.from(c.certificadoBase64, 'base64'), senha: senhaUsada });
        const r = String(await t.sefazStatus());
        return { cStat: (r.match(/<cStat>(\d+)</) || [])[1] || '?', xMotivo: (r.match(/<xMotivo>([^<]+)</) || [])[1] || '' };
      } catch (e) { return { cStat: 'ERRO', xMotivo: String((e && e.message) || e).slice(0, 120) }; }
    };
    const real = senha == null ? { cStat: 'ERRO', xMotivo: 'sem senha' } : await status(senha);
    const errada = await status('senha-errada-de-controle');
    const cStat = real.cStat, xMotivo = real.xMotivo;
    db.close();
    console.log(`${slug}: formato=${formato} bancoSozinhoAbrePfx=${soBanco} chaveAbrePfx=${senha != null && abre(c.certificadoBase64, senha)} senha#=${hash}`
      + ` sefaz=${cStat} ${xMotivo} | controle com senha errada: ${errada.cStat} ${errada.xMotivo}`);
    if (!/^\d+$/.test(cStat) || /^\d+$/.test(errada.cStat)) falhas++;
  }
  process.exit(falhas ? 1 : 0);
})();
