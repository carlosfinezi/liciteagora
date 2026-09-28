// cert-senha.js
//
// A senha do certificado digital A1, guardada CIFRADA.
//
// Até 2026-09-27 ela ficava em `certificado_digital.senhaCriptografada` apenas
// em base64: quem tivesse o pncp.db de um tenant tinha, na mesma linha, o .pfx
// e a senha que o abre, ou seja, a assinatura fiscal da empresa inteira.
//
// AES-256-GCM, com a chave em LICITEAGORA_CHAVE_CERT (64 hexadecimais). Ela
// NÃO mora no banco nem na árvore: vem de /etc/liciteagora/chave-certificado.env,
// carregado pelo systemd (EnvironmentFile) nas duas units. O backup dos bancos
// não leva a chave, e é isso que faz o banco sozinho não revelar a senha.
//
// O próprio certificado entra como dado autenticado (hash do pfx): a senha de
// uma linha copiada para outra NÃO decifra. Sem isso, quem mexesse numa linha
// poderia trocar o pfx e continuar usando a senha cifrada que já estava lá.
//
// Formato gravado: `v1.<iv>.<marca>.<corpo>`, em base64url. Valor sem o
// prefixo é o formato antigo (base64 puro), ainda aceito na leitura para que
// nada pare enquanto a migração do db-schema.js não roda com a chave. Gravar
// sem chave é recusado: nunca mais nasce senha em base64.
//
// Perder a chave é perder as senhas: cada tenant reenvia o certificado com a
// senha em Configurações > Minha empresa. O pfx continua no banco; só a senha
// some. Ver "Chave do certificado A1" no CLAUDE.md.

const crypto = require('crypto');

const PREFIXO = 'v1.';

function chave() {
  const hex = process.env.LICITEAGORA_CHAVE_CERT || '';
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

const temChave = () => chave() !== null;

const amarrar = (certificadoBase64) => Buffer.concat([
  Buffer.from('liciteagora:certificado-a1:'),
  crypto.createHash('sha256').update(String(certificadoBase64 || '')).digest(),
]);

const cifrada = (valor) => typeof valor === 'string' && valor.startsWith(PREFIXO);

function cifrarSenha(senha, certificadoBase64) {
  const k = chave();
  if (!k) {
    throw new Error('LICITEAGORA_CHAVE_CERT ausente ou inválida: a senha do certificado '
      + 'não pode ser gravada sem ela (ver /etc/liciteagora/chave-certificado.env)');
  }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(amarrar(certificadoBase64));
  const corpo = Buffer.concat([c.update(String(senha), 'utf8'), c.final()]);
  return 'v1.' + [iv, c.getAuthTag(), corpo].map(b => b.toString('base64url')).join('.');
}

function decifrarSenha(valor, certificadoBase64) {
  if (valor == null || valor === '') return '';
  if (!cifrada(valor)) return Buffer.from(valor, 'base64').toString('utf8');
  const k = chave();
  if (!k) {
    throw new Error('LICITEAGORA_CHAVE_CERT ausente: a senha do certificado está cifrada '
      + 'e não pode ser lida sem a chave');
  }
  const [, iv, marca, corpo] = valor.split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
  d.setAAD(amarrar(certificadoBase64));
  d.setAuthTag(Buffer.from(marca, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(corpo, 'base64url')), d.final()]).toString('utf8');
}

/**
 * Cifra as senhas ainda em base64 de um banco de tenant. Roda no boot, pelo
 * db-schema.js. Sem chave não faz nada e devolve quantas ficaram pendentes,
 * para o log dizer que a migração não aconteceu, em vez de calar.
 */
function migrarSenhas(db) {
  const antigas = db.prepare(`SELECT id, certificadoBase64, senhaCriptografada FROM certificado_digital
    WHERE senhaCriptografada IS NOT NULL AND senhaCriptografada != ''
      AND senhaCriptografada NOT LIKE 'v1.%'`).all();
  if (!antigas.length) return { migradas: 0, pendentes: 0 };
  if (!temChave()) return { migradas: 0, pendentes: antigas.length };
  const upd = db.prepare('UPDATE certificado_digital SET senhaCriptografada = ? WHERE id = ? AND senhaCriptografada = ?');
  let migradas = 0;
  db.transaction(() => {
    for (const r of antigas) {
      const senha = Buffer.from(r.senhaCriptografada, 'base64').toString('utf8');
      const nova = cifrarSenha(senha, r.certificadoBase64);
      // Prova antes de gravar: o que foi cifrado volta igual.
      if (decifrarSenha(nova, r.certificadoBase64) !== senha) throw new Error('cifra não confere');
      migradas += upd.run(nova, r.id, r.senhaCriptografada).changes;
    }
  })();
  return { migradas, pendentes: antigas.length - migradas };
}

module.exports = { cifrarSenha, decifrarSenha, migrarSenhas, temChave, cifrada };
