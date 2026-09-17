/**
 * Documento fiscal: quem tem, quem não tem, e quem só PARECE ter.
 *
 * A regra vale para três famílias de valor gravadas em `pessoas.cpfCnpj`:
 *   1. documento real — CPF (11) ou CNPJ (14);
 *   2. identificador interno da Fase 1 — 'SD-<uuid>', com `semDocumento = 1`;
 *   3. identificadores LEGADOS que o ERP já grava há tempos — 'UASG-<código>',
 *      'EX-NICSRS', 'EX-CONTABO', 'TARIFA-asaas', '193099'.
 *
 * Nenhum da 2ª e da 3ª família pode virar documento fiscal — nem depois do
 * `replace(/\D/g,'')` que os emissores aplicam. Ver relatório 15 §B.
 */
const path = require('path');
const m = require(path.join(__dirname, '..', 'pessoa-sem-documento'));

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, msg) => { if (!c) throw new Error(msg); };

// ---------- 1. PESSOA NORMAL ----------
t('1-a CPF válido é documento fiscal', () => {
  assert(m.documentoFiscalDe({ cpfCnpj: '11144477735' }) === '11144477735', 'CPF recusado');
  assert(m.documentoFiscalDe({ cpfCnpj: '111.444.777-35' }) === '11144477735', 'CPF com máscara recusado');
});
t('1-b CNPJ válido é documento fiscal', () => {
  assert(m.documentoFiscalDe({ cpfCnpj: '11222333000181' }) === '11222333000181', 'CNPJ recusado');
  assert(m.documentoFiscalDe({ cpfCnpj: '11.222.333/0001-81' }) === '11222333000181', 'CNPJ com máscara recusado');
});
t('1-c exigirDocumentoFiscal devolve o documento, sem erro', () => {
  const r = m.exigirDocumentoFiscal({ cpfCnpj: '11144477735', razaoSocial: 'Ana' }, 'NF-e');
  assert(r.documento === '11144477735' && !r.erro, JSON.stringify(r));
});

// ---------- 2. SEM DOCUMENTO ----------
t('2-a semDocumento=1 ⇒ documento AUSENTE', () => {
  const p = { cpfCnpj: m.gerarIdentificadorSemDocumento(), semDocumento: 1, razaoSocial: 'Diego' };
  assert(m.documentoFiscalDe(p) === null, 'devolveu documento');
  assert(m.rotuloDocumento(p) === 'sem documento', 'rótulo vazou o identificador');
});
t('2-b o prefixo SD- basta, mesmo sem a coluna semDocumento (rollout parcial)', () => {
  const p = { cpfCnpj: m.gerarIdentificadorSemDocumento() };   // sem semDocumento
  assert(m.documentoFiscalDe(p) === null, 'devolveu documento sem a coluna');
});
t('2-c NF-e: a tag CPF/CNPJ simplesmente não é montada', () => {
  // Reproduz `nfe-emit-routes.js`: só monta a tag com 11 ou 14 dígitos.
  const destCpfCnpj = m.documentoFiscalDe({ cpfCnpj: m.gerarIdentificadorSemDocumento(), semDocumento: 1 }) || '';
  const destTag = {};
  if (destCpfCnpj.length === 14) destTag.CNPJ = destCpfCnpj;
  else if (destCpfCnpj.length === 11) destTag.CPF = destCpfCnpj;
  assert(!destTag.CPF && !destTag.CNPJ, 'montou documento falso: ' + JSON.stringify(destTag));
});
t('2-d caminho que EXIGE documento devolve erro claro, antes de emitir', () => {
  const r = m.exigirDocumentoFiscal({ cpfCnpj: m.gerarIdentificadorSemDocumento(), semDocumento: 1,
    razaoSocial: 'Diego do Balcão' }, 'boleto ou cobrança Pix');
  assert(!r.documento, 'deixou passar');
  assert(/sem CPF\/CNPJ/i.test(r.erro), 'mensagem=' + r.erro);
  assert(/Diego do Balcão/.test(r.erro), 'a mensagem não diz de quem é: ' + r.erro);
  assert(/boleto ou cobrança Pix/.test(r.erro), 'a mensagem não diz o que se ia emitir');
});
t('2-e o identificador NUNCA sobra com 11 ou 14 dígitos', () => {
  for (let i = 0; i < 20000; i++) {
    const n = m.gerarIdentificadorSemDocumento().replace(/\D/g, '').length;
    assert(n !== 11 && n !== 14, `gerou identificador que vira documento de ${n} dígitos`);
  }
});
t('2-f identificadores gerados não colidem', () => {
  const vistos = new Set();
  for (let i = 0; i < 20000; i++) vistos.add(m.gerarIdentificadorSemDocumento());
  assert(vistos.size === 20000, 'colisão em ' + (20000 - vistos.size));
});

// ---------- 3. IDENTIFICADORES LEGADOS ----------
t('3-a os legados REAIS de produção não viram documento', () => {
  // Estes quatro existem hoje nos bancos (relatório 13 §7).
  for (const legado of ['EX-NICSRS', 'EX-CONTABO', 'TARIFA-asaas', '193099']) {
    assert(m.documentoFiscalDe({ cpfCnpj: legado }) === null, `${legado} virou documento`);
  }
});
t('3-b UASG-<código> não vira documento', () => {
  assert(m.documentoFiscalDe({ cpfCnpj: 'UASG-925474' }) === null, 'UASG curto passou');
});
t('3-c o caso PERIGOSO: legado cujos dígitos dão 11 ou 14', () => {
  // 'UASG-12345678901' → replace(/\D/g,'') → '12345678901' (11 dígitos).
  // Sem a guarda de letra, viraria CPF dentro da nota.
  assert(m.documentoFiscalDe({ cpfCnpj: 'UASG-12345678901' }) === null, 'virou CPF falso');
  assert(m.documentoFiscalDe({ cpfCnpj: 'EX-12345678000199' }) === null, 'virou CNPJ falso');
  assert(m.documentoFiscalDe({ cpfCnpj: 'TARIFA-11144477735' }) === null, 'virou CPF falso');
});
t('3-d número puro com comprimento errado também não passa', () => {
  for (const v of ['123', '1234567890', '123456789012', '1234567890123456']) {
    assert(m.documentoFiscalDe({ cpfCnpj: v }) === null, `${v} (${v.length} dígitos) virou documento`);
  }
});

// ---------- 4. BORDAS ----------
t('4-a nulo, vazio e pessoa ausente não quebram', () => {
  assert(m.documentoFiscalDe(null) === null, 'null');
  assert(m.documentoFiscalDe({}) === null, 'objeto vazio');
  assert(m.documentoFiscalDe({ cpfCnpj: null }) === null, 'cpfCnpj null');
  assert(m.documentoFiscalDe({ cpfCnpj: '' }) === null, 'cpfCnpj vazio');
});
t('4-b semDocumento=1 vence até um documento válido gravado', () => {
  // Estado contraditório: a declaração explícita manda.
  assert(m.documentoFiscalDe({ cpfCnpj: '11144477735', semDocumento: 1 }) === null, 'ignorou semDocumento');
});
t('4-c ehIdentificadorInterno reconhece só o prefixo da Fase 1', () => {
  assert(m.ehIdentificadorInterno(m.gerarIdentificadorSemDocumento()), 'não reconheceu o próprio');
  assert(!m.ehIdentificadorInterno('11144477735'), 'confundiu CPF');
  assert(!m.ehIdentificadorInterno('UASG-123'), 'confundiu legado');
  assert(!m.ehIdentificadorInterno(null), 'quebrou com null');
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
