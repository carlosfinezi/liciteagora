/**
 * test-documento-validacao.js — a conferência do CPF/CNPJ na fronteira.
 *
 * Duas metades, e a segunda é a que importa mais:
 *
 *   1. documento com dígito errado, tamanho errado ou repetido é RECUSADO;
 *   2. identificador interno do próprio sistema é ACEITO — `SD-<uuid>` dos
 *      leads, `EX-` de fornecedor de fora, `UASG-<código>` de órgão,
 *      `TARIFA-`. Sem esta metade, a validação recusaria 9.783 fichas que
 *      estão certas (medido nos 20 tenants em 30/09/2026) e travaria a edição
 *      de um terço do cadastro do 1bit.
 *
 * Roda da raiz do projeto: node scripts/test-documento-validacao.js
 */
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const semDoc = require(path.join(RAIZ, 'pessoa-sem-documento'));

let falhas = 0, total = 0;
function checa(rotulo, condicao, detalhe = '') {
  total++;
  if (condicao) { console.log(`  ok   ${rotulo}`); return; }
  falhas++;
  console.log(`  FALHA ${rotulo}${detalhe ? ' — ' + detalhe : ''}`);
}

console.log('\nA. documento válido passa');
// CPFs e CNPJs com DV correto (gerados para o teste, não são de ninguém).
for (const cpf of ['529.982.247-25', '111.444.777-35', '52998224725']) {
  checa(`CPF ${cpf}`, semDoc.erroDeDocumento(cpf) === null, semDoc.erroDeDocumento(cpf) || '');
}
for (const cnpj of ['11.222.333/0001-81', '11222333000181']) {
  checa(`CNPJ ${cnpj}`, semDoc.erroDeDocumento(cnpj) === null, semDoc.erroDeDocumento(cnpj) || '');
}

console.log('\nB. documento errado é recusado, com a frase certa');
const recusas = [
  ['1', 'tamanho'],
  ['529.982.247-26', 'dígito'],
  ['11.222.333/0001-82', 'dígito'],
  ['111.111.111-11', 'repetido'],
  ['11.111.111/1111-11', 'repetido'],
  ['1112223334', '10 dígitos'],
  ['112223330001811', '15 dígitos'],
  ['', 'vazio'],
  ['   ', 'só espaço'],
];
for (const [valor, porque] of recusas) {
  const erro = semDoc.erroDeDocumento(valor);
  checa(`recusa "${valor}" (${porque})`, typeof erro === 'string' && erro.length > 8, `devolveu ${JSON.stringify(erro)}`);
}

console.log('\nC. identificador interno do sistema é aceito (a metade que protege o legado)');
const internos = [
  semDoc.gerarIdentificadorSemDocumento(),
  'SD-9f2c4e1a7b8d4c3e9a1b2c3d4e5f6071',
  'EX-NICSRS',
  'EX-CONTABO',
  'TARIFA-asaas',
  'UASG-193099',
];
for (const v of internos) {
  checa(`aceita ${v.slice(0, 24)}`, semDoc.erroDeDocumento(v) === null, semDoc.erroDeDocumento(v) || '');
}

console.log('\nD. campo que só admite um dos dois');
checa('exige=cpf recusa CNPJ válido', semDoc.erroDeDocumento('11222333000181', { exige: 'cpf' }) !== null);
checa('exige=cpf aceita CPF válido', semDoc.erroDeDocumento('52998224725', { exige: 'cpf' }) === null);
checa('exige=cnpj recusa CPF válido', semDoc.erroDeDocumento('52998224725', { exige: 'cnpj' }) !== null);
checa('exige=cnpj aceita CNPJ válido', semDoc.erroDeDocumento('11222333000181', { exige: 'cnpj' }) === null);
checa('exige=cnpj ainda aceita identificador interno', semDoc.erroDeDocumento('EX-NICSRS', { exige: 'cnpj' }) === null);

console.log('\nE. o identificador gerado nunca parece documento');
// O emissor fiscal limpa com replace(/\D/g,''); se sobrarem 11 ou 14 dígitos,
// a nota sai com um número inventado. Ver o comentário do módulo.
let pareceuDocumento = 0;
for (let i = 0; i < 3000; i++) {
  const id = semDoc.gerarIdentificadorSemDocumento();
  const n = id.replace(/\D/g, '').length;
  if (n === 11 || n === 14) pareceuDocumento++;
}
checa('3.000 identificadores, nenhum com 11 ou 14 dígitos depois de limpo', pareceuDocumento === 0, `${pareceuDocumento} pareceram`);

console.log('\nF. a loja e o cadastro usam a MESMA conferência');
const lojaSrc = require('fs').readFileSync(path.join(RAIZ, 'loja-routes.js'), 'utf8');
checa('loja-routes usa semDoc.cpfValido/cnpjValido', /semDoc\.cpfValido/.test(lojaSrc) && /semDoc\.cnpjValido/.test(lojaSrc));
checa('loja-routes não tem mais cópia do cálculo de DV', !/reduce\(\(acc, n, i\) => acc \+ Number\(n\) \* \(peso - i\)/.test(lojaSrc));
const finSrc = require('fs').readFileSync(path.join(RAIZ, 'financeiro-routes.js'), 'utf8');
checa('POST /api/pessoas chama erroDeDocumento', /erroDeDocumento\(cpfCnpj\)/.test(finSrc));

console.log(`\n${falhas ? 'FALHOU' : 'OK'}: ${total - falhas}/${total} checagens`);
process.exit(falhas ? 1 : 0);
