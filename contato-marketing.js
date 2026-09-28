// contato-marketing.js
//
// E-mail e aceite de promoções coletados na venda: no checkout da loja e no
// balcão (PDV). Grava nos campos de LGPD que o cadastro já tinha e que as
// campanhas já leem (comm-destinos.js: aceitaEmailMarketing e
// aceitaWhatsappMarketing).
//
// Três regras, e cada uma evita um estrago diferente:
//
//  - O aceite só LIGA. Cliente que já aceitou e compra de novo sem marcar a
//    caixa não é descadastrado: não marcar não é pedir para sair. Sair é pelo
//    descadastro das campanhas (comm_optout), que continua valendo sempre e
//    que este módulo não toca.
//  - O e-mail só preenche o que está vazio. O cadastro pode ter o e-mail que o
//    financeiro usa, e o do checkout não passa por cima dele.
//  - Aceite vem com data e origem (lgpdDataConsentimento, lgpdFonte): é o que
//    prova de onde veio o consentimento, que é o que a LGPD pede.

const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

/** null = não informado; false = informado e inválido; string = normalizado. */
function lerEmail(valor) {
  const v = String(valor == null ? '' : valor).trim().toLowerCase();
  if (!v) return null;
  return v.length <= 120 && EMAIL.test(v) ? v : false;
}

function aplicarContato(db, pessoaId, { email = null, aceite = false, fonte }) {
  if (!pessoaId) return;
  if (email) {
    db.prepare("UPDATE pessoas SET email = ? WHERE id = ? AND COALESCE(TRIM(email), '') = ''").run(email, pessoaId);
  }
  if (aceite) {
    db.prepare(`UPDATE pessoas SET lgpdConsentimento = 1, lgpdDataConsentimento = datetime('now'),
        lgpdFonte = ?, aceitaEmailMarketing = 1, aceitaWhatsappMarketing = 1 WHERE id = ?`)
      .run(fonte, pessoaId);
  }
}

/**
 * Contato do balcão. A pessoa da VENDA continua sendo decidida pelo PDV (só
 * com CPF/CNPJ); isto aqui só guarda quem quer receber promoção. Sem
 * documento, acha pelo e-mail ou cria um cadastro sem documento, e esse
 * cadastro não entra na nota nem na conta a receber.
 */
function contatoDoBalcao(db, { cpfCnpj, nome, email, aceite }) {
  if (!email && !aceite) return null;
  const digits = String(cpfCnpj || '').replace(/\D/g, '');
  let pessoa = digits ? db.prepare('SELECT id FROM pessoas WHERE cpfCnpj = ?').get(digits) : null;
  if (!pessoa && email) pessoa = db.prepare('SELECT id FROM pessoas WHERE LOWER(TRIM(email)) = ? ORDER BY id LIMIT 1').get(email);
  if (!pessoa) {
    // Sem documento e sem e-mail não há como contatar: o aceite não tem onde morar.
    if (!email) return null;
    const semDoc = require('./pessoa-sem-documento');
    const id = db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, email, ativo, semDocumento, origem)
      VALUES (?, 'PF', ?, ?, 1, 1, 'pdv')`)
      .run(semDoc.gerarIdentificadorSemDocumento(), String(nome || '').trim().slice(0, 120) || 'Cliente do balcão', email)
      .lastInsertRowid;
    pessoa = { id };
  }
  aplicarContato(db, pessoa.id, { email, aceite, fonte: 'pdv' });
  return pessoa.id;
}

module.exports = { lerEmail, aplicarContato, contatoDoBalcao };
