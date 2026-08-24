/**
 * Cadastro de usuários: validação na origem e diagnóstico de acesso.
 *
 * O login já estava bem protegido (rate limit por IP, mensagem uniforme
 * anti-enumeração, regeneração de sessão) e o middleware revalida `ativo` a
 * cada request — desativar derruba a sessão de verdade.
 *
 * O buraco era do outro lado: três campos do cadastro alimentam o motor de
 * comissão e nenhum tinha validação.
 *
 *   comissaoPercentual — vira percentual sobre a venda quando o vendedor não
 *                        tem regra escrita. 500 no lugar de 5 paga 5x a venda.
 *   cpfCnpj            — é por ele que o pagamento acha o fornecedor.
 *   metaMensal         — alimenta gatilho e acelerador.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const regras = require('../usuarios-regras');

const DB = '/tmp/vp-users.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-users-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
  try { db.exec(`INSERT OR IGNORE INTO ${m[1]} (id) VALUES (1)`); } catch {}
}

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const tem = (ps, cod) => ps.some((p) => p.codigo === cod);
const codigos = (ps) => ps.map((p) => p.codigo).join(', ') || '(nenhum)';

// ---------- app ----------
const app = express();
app.use(express.json());
require('../usuarios-routes').registrarRotasUsuarios(app, db);

let USUARIO_REQ = null;
function call(m, p, body = {}, params = {}, query = {}) {
  let h = null;
  for (const c of app.router.stack) {
    if (c.route && c.route.path === p && c.route.methods[m]) h = c.route.stack[c.route.stack.length - 1].handle;
  }
  if (!h) throw new Error('rota não encontrada: ' + m + ' ' + p);
  let o = null;
  h({ body, params, query, user: USUARIO_REQ, session: {} },
    { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(j) { o = { status: this.statusCode, body: j }; } },
    () => {});
  if (!o) throw new Error('handler não respondeu');
  return o;
}

let seq = 0;
const novoUsuario = (o = {}) => db.prepare(`INSERT INTO users
  (username, passwordHash, nome, email, role, ativo, ultimoLogin, ehVendedor, cpfCnpj, comissaoPercentual, metaMensal)
  VALUES (@username, @passwordHash, @nome, @email, @role, @ativo, @ultimoLogin, @ehVendedor, @cpfCnpj, @comissaoPercentual, @metaMensal)`)
  .run({ username: 'user' + (++seq), passwordHash: bcrypt.hashSync('segredo123', 4), nome: 'Fulano',
         email: null, role: 'operacional', ativo: 1, ultimoLogin: null, ehVendedor: 0,
         cpfCnpj: null, comissaoPercentual: null, metaMensal: null, ...o }).lastInsertRowid;

function limpar() {
  try { db.exec('DELETE FROM comissoes_apuracao; DELETE FROM comissoes_regras;'); } catch {}
  db.exec('DELETE FROM users; DELETE FROM fornecedores;');
  // comissoes_apuracao aponta para pedidos e pedido_itens. `pedidos` é tabela
  // real (com NOT NULL), então precisa de uma linha de verdade — um INSERT só
  // com id falha calado e as FKs dos testes seguintes estouram.
  try {
    db.exec("DELETE FROM pedidos");
    db.exec(`INSERT INTO pedidos (id, numero, tipo, clienteId, status, dataPedido, valorTotal, statusPagamento)
             VALUES (1, 'P-FK', 'venda', 1, 'confirmado', '2026-07-01', 1000, 'pendente')`);
  } catch {}
  try { db.exec('INSERT OR IGNORE INTO pedido_itens (id) VALUES (1)'); } catch {}
  seq = 0;
  USUARIO_REQ = null;
}

// ==================== DOCUMENTO ====================
console.log('\n--- CPF e CNPJ ---');

t('CPF válido é aceito com e sem máscara', () => {
  assert(regras.cpfValido('529.982.247-25') && regras.cpfValido('52998224725'), 'recusou CPF válido');
});

t('CPF com dígito errado e sequência repetida são recusados', () => {
  assert(!regras.cpfValido('529.982.247-26'), 'aceitou DV errado');
  assert(!regras.cpfValido('11111111111'), 'aceitou repetido');
});

t('CNPJ válido é aceito', () => {
  assert(regras.cnpjValido('11.222.333/0001-81'), 'recusou CNPJ válido');
});

t('CNPJ com dígito errado é recusado', () => {
  assert(!regras.cnpjValido('11.222.333/0001-82'), 'aceitou DV errado');
  assert(!regras.cnpjValido('11111111111111'), 'aceitou repetido');
});

t('documentoValido aceita os dois tamanhos e recusa o resto', () => {
  assert(regras.documentoValido('52998224725'), 'CPF');
  assert(regras.documentoValido('11222333000181'), 'CNPJ');
  assert(!regras.documentoValido('123'), 'aceitou lixo');
});

// ==================== SENHA ====================
console.log('\n--- senha ---');

t('abaixo do mínimo é erro', () => {
  assert(tem(regras.avaliarSenha('abc12'), 'senha_curta'), codigos(regras.avaliarSenha('abc12')));
});

t('senha óbvia é bloqueada — é a primeira que se tenta', () => {
  for (const s of ['123456', 'senha123', 'admin123', 'qwerty']) {
    assert(tem(regras.avaliarSenha(s), 'senha_obvia'), 'passou: ' + s);
  }
});

t('senha contendo o username é bloqueada', () => {
  const p = regras.avaliarSenha('joaosilva99', { username: 'joaosilva' });
  assert(tem(p, 'senha_igual_username'), codigos(p));
});

t('username curto não gera falso positivo', () => {
  // 'ab' apareceria dentro de quase qualquer senha.
  const p = regras.avaliarSenha('abacaxi2026!', { username: 'ab' });
  assert(!tem(p, 'senha_igual_username'), codigos(p));
});

t('senha com o primeiro nome é aviso, não bloqueio', () => {
  const p = regras.avaliarSenha('Roberto2026', { username: 'rsilva', nome: 'Roberto Silva' });
  const a = p.find((x) => x.codigo === 'senha_com_nome');
  assert(a && a.nivel === 'aviso', codigos(p));
});

t('senha longa de um tipo só passa (frase longa é forte)', () => {
  const p = regras.avaliarSenha('cavalobateriagrampoazul');
  assert(!p.some((x) => x.nivel === 'erro'), codigos(p));
  assert(!tem(p, 'senha_pouco_variada'), 'acusou frase longa');
});

t('senha curta e monótona ganha aviso de variedade', () => {
  const p = regras.avaliarSenha('abcdefg');
  assert(tem(p, 'senha_pouco_variada'), codigos(p));
});

// ==================== CADASTRO ====================
console.log('\n--- o que não pode ser gravado ---');

t('comissão acima de 100% é recusada', () => {
  limpar();
  // O motor de comissão usa este campo como percentual sobre a venda: 500
  // pagaria cinco vezes o valor vendido.
  const p = regras.validarUsuario(db, { ehVendedor: 1, comissaoPercentual: 500 });
  assert(tem(p, 'comissao_acima_de_100'), codigos(p));
});

t('comissão negativa é recusada', () => {
  assert(tem(regras.validarUsuario(db, { comissaoPercentual: -5 }), 'comissao_invalida'));
});

t('comissão alta mas plausível passa com aviso', () => {
  const p = regras.validarUsuario(db, { ehVendedor: 1, comissaoPercentual: 45, cpfCnpj: '52998224725' });
  const a = p.find((x) => x.codigo === 'comissao_alta');
  assert(a && a.nivel === 'aviso', codigos(p));
});

t('meta negativa é recusada', () => {
  assert(tem(regras.validarUsuario(db, { metaMensal: -100 }), 'meta_invalida'));
});

t('CPF inválido no cadastro é recusado', () => {
  limpar();
  assert(tem(regras.validarUsuario(db, { cpfCnpj: '111.111.111-11' }), 'documento_invalido'));
});

t('CPF duplicado entre usuários é recusado', () => {
  limpar();
  novoUsuario({ username: 'ana', cpfCnpj: '529.982.247-25' });
  const p = regras.validarUsuario(db, { cpfCnpj: '52998224725' });
  // Máscara diferente é o mesmo documento.
  assert(tem(p, 'documento_duplicado'), codigos(p));
});

t('editar o próprio registro não acusa duplicidade contra si', () => {
  limpar();
  const id = novoUsuario({ username: 'ana', cpfCnpj: '529.982.247-25' });
  const p = regras.validarUsuario(db, { cpfCnpj: '529.982.247-25' }, { id });
  assert(!tem(p, 'documento_duplicado'), codigos(p));
});

t('e-mail inválido é recusado', () => {
  limpar();
  assert(tem(regras.validarUsuario(db, { email: 'joao@' }), 'email_invalido'));
});

t('e-mail repetido é aviso — quebra recuperação de senha', () => {
  limpar();
  novoUsuario({ username: 'ana', email: 'contato@empresa.com' });
  const p = regras.validarUsuario(db, { email: 'CONTATO@Empresa.com' });
  const a = p.find((x) => x.codigo === 'email_duplicado');
  assert(a && a.nivel === 'aviso', codigos(p));
});

console.log('\n--- coerência do vendedor ---');

t('vendedor sem CPF é avisado: a comissão não vai poder ser paga', () => {
  limpar();
  const p = regras.validarUsuario(db, { ehVendedor: 1, comissaoPercentual: 5 });
  assert(tem(p, 'vendedor_sem_documento'), codigos(p));
});

t('vendedor com CPF sem fornecedor correspondente é avisado', () => {
  limpar();
  const p = regras.validarUsuario(db, { ehVendedor: 1, cpfCnpj: '529.982.247-25', comissaoPercentual: 5 });
  assert(tem(p, 'vendedor_sem_fornecedor'), codigos(p));
});

t('com fornecedor cadastrado o aviso some', () => {
  limpar();
  db.prepare("INSERT INTO fornecedores (cpfCnpj, tipo, razaoSocial) VALUES ('529.982.247-25','PF','Ana')").run();
  const p = regras.validarUsuario(db, { ehVendedor: 1, cpfCnpj: '52998224725', comissaoPercentual: 5 });
  assert(!tem(p, 'vendedor_sem_fornecedor'), codigos(p));
});

t('vendedor sem percentual e sem regra alcançável é avisado', () => {
  limpar();
  const p = regras.validarUsuario(db, { ehVendedor: 1, cpfCnpj: '52998224725' });
  assert(tem(p, 'vendedor_sem_comissao'), codigos(p));
});

t('havendo regra geral de comissão, o aviso não aparece', () => {
  limpar();
  db.prepare(`INSERT INTO comissoes_regras (nome, tipo, valor, ativo) VALUES ('Geral','percentual_venda',5,1)`).run();
  const p = regras.validarUsuario(db, { ehVendedor: 1, cpfCnpj: '52998224725' });
  assert(!tem(p, 'vendedor_sem_comissao'), codigos(p));
});

t('campos de vendedor com a flag desligada são apontados como ignorados', () => {
  limpar();
  const p = regras.validarUsuario(db, { ehVendedor: 0, comissaoPercentual: 5, metaMensal: 10000 });
  // Quem preencheu acha que configurou algo; nada disso é lido.
  assert(tem(p, 'campos_de_vendedor_ignorados'), codigos(p));
});

t('tipo de vendedor inventado é recusado', () => {
  assert(tem(regras.validarUsuario(db, { vendedorTipo: 'freelancer' }), 'vendedor_tipo_invalido'));
});

// ==================== ROTAS ====================
console.log('\n--- rotas ---');

t('criar com comissão de 500% é recusado pela rota', () => {
  limpar();
  USUARIO_REQ = { id: 1, role: 'admin', username: 'admin' };
  const r = call('post', '/api/usuarios',
    { username: 'vend', senha: 'Segredo!2026', role: 'comercial', ehVendedor: 1, comissaoPercentual: 500 });
  assert(r.status === 400 && /0 a 100/.test(r.body.error), JSON.stringify(r.body));
  assert(db.prepare('SELECT COUNT(*) n FROM users').get().n === 0, 'gravou mesmo recusando');
});

t('criar com senha óbvia é recusado', () => {
  limpar();
  USUARIO_REQ = { id: 1, role: 'admin', username: 'admin' };
  const r = call('post', '/api/usuarios', { username: 'novo', senha: 'senha123', role: 'operacional' });
  assert(r.status === 400 && /comum/i.test(r.body.error), JSON.stringify(r.body));
});

t('criar válido passa e devolve os avisos', () => {
  limpar();
  USUARIO_REQ = { id: 1, role: 'admin', username: 'admin' };
  const r = call('post', '/api/usuarios',
    { username: 'vend', senha: 'Chuva!Verde42', role: 'comercial', ehVendedor: 1, comissaoPercentual: 5 });
  assert(r.body.success, JSON.stringify(r.body));
  // Sem CPF e sem fornecedor: passa, mas o admin precisa saber.
  assert(r.body.avisos.some((a) => a.codigo === 'vendedor_sem_documento'), JSON.stringify(r.body.avisos));
});

t('trocar a própria senha para a mesma é recusado', () => {
  limpar();
  const id = novoUsuario({ username: 'ana', passwordHash: bcrypt.hashSync('Chuva!Verde42', 4) });
  USUARIO_REQ = { id, role: 'operacional', username: 'ana' };
  const r = call('put', '/api/usuarios/me/senha', { senhaAtual: 'Chuva!Verde42', senhaNova: 'Chuva!Verde42' });
  assert(r.status === 400 && /igual à atual/.test(r.body.error), JSON.stringify(r.body));
});

t('trocar a própria senha para uma óbvia é recusado', () => {
  const r = call('put', '/api/usuarios/me/senha', { senhaAtual: 'Chuva!Verde42', senhaNova: '12345678' });
  assert(r.status === 400 && /comum/i.test(r.body.error), JSON.stringify(r.body));
});

t('trocar para senha boa funciona', () => {
  const r = call('put', '/api/usuarios/me/senha', { senhaAtual: 'Chuva!Verde42', senhaNova: 'Trovao#Azul77' });
  assert(r.body.success, JSON.stringify(r.body));
});

t('e-mail inválido no próprio perfil é recusado', () => {
  const r = call('put', '/api/usuarios/me', { email: 'nao-e-email' });
  assert(r.status === 400, 'status: ' + r.status);
});

t('a rota de diagnóstico não é engolida por /usuarios/:id', () => {
  limpar();
  USUARIO_REQ = { id: 1, role: 'admin', username: 'admin' };
  novoUsuario({ username: 'ana', role: 'admin' });
  const r = call('get', '/api/usuarios/diagnostico', {}, {}, {});
  // Registrada depois de :id, viraria uma busca pelo usuário "diagnostico".
  assert(r.body.success && r.body.diagnostico, JSON.stringify(r.body));
});

// ==================== DIAGNÓSTICO ====================
console.log('\n--- diagnóstico de acesso ---');

t('aponta quem nunca entrou', () => {
  limpar();
  novoUsuario({ username: 'novato', ultimoLogin: null });
  novoUsuario({ username: 'veterano', ultimoLogin: '2026-07-30 10:00:00' });
  const d = regras.diagnostico(db, { agora: '2026-08-02T12:00:00Z' });
  assert(d.nuncaEntraram.length === 1 && d.nuncaEntraram[0].username === 'novato', JSON.stringify(d.nuncaEntraram));
});

t('aponta quem sumiu há mais de 60 dias', () => {
  limpar();
  novoUsuario({ username: 'sumido', ultimoLogin: '2026-01-10 09:00:00' });
  novoUsuario({ username: 'ativo', ultimoLogin: '2026-07-30 09:00:00' });
  const d = regras.diagnostico(db, { agora: '2026-08-02T12:00:00Z' });
  assert(d.semAcessoRecente.length === 1 && d.semAcessoRecente[0].username === 'sumido', JSON.stringify(d.semAcessoRecente));
  assert(d.semAcessoRecente[0].dias > 180, 'dias: ' + d.semAcessoRecente[0].dias);
});

t('usuário inativo não entra nos alertas', () => {
  limpar();
  novoUsuario({ username: 'demitido', ativo: 0, ultimoLogin: null });
  const d = regras.diagnostico(db, { agora: '2026-08-02T12:00:00Z' });
  assert(d.nuncaEntraram.length === 0, 'contou inativo');
  assert(d.inativos === 1 && d.ativos === 0, JSON.stringify(d));
});

t('avisa quando há um único administrador', () => {
  limpar();
  novoUsuario({ username: 'chefe', role: 'admin' });
  novoUsuario({ username: 'op', role: 'operacional' });
  const d = regras.diagnostico(db, { agora: '2026-08-02T12:00:00Z' });
  // Férias, demissão ou senha perdida deixam a empresa sem administrador.
  assert(d.adminUnico && d.adminUnico.username === 'chefe', JSON.stringify(d.adminUnico));
});

t('com dois admins o alerta some', () => {
  novoUsuario({ username: 'chefe2', role: 'admin' });
  assert(regras.diagnostico(db, { agora: '2026-08-02T12:00:00Z' }).adminUnico === null, 'ainda acusou');
});

t('lista vendedor que não consegue receber comissão', () => {
  limpar();
  novoUsuario({ username: 'vend1', ehVendedor: 1, cpfCnpj: null });
  novoUsuario({ username: 'vend2', ehVendedor: 1, cpfCnpj: '529.982.247-25' });
  const d = regras.diagnostico(db, { agora: '2026-08-02T12:00:00Z' });
  assert(d.vendedores === 2, 'vendedores: ' + d.vendedores);
  assert(d.vendedoresSemPagamento.length === 1 && d.vendedoresSemPagamento[0].username === 'vend1',
    JSON.stringify(d.vendedoresSemPagamento));
});

t('aponta comissão pendente de vendedor já desativado', () => {
  limpar();
  const id = novoUsuario({ username: 'exvend', ehVendedor: 1, ativo: 0 });
  db.prepare(`INSERT INTO comissoes_apuracao
    (periodo, vendedorId, pedidoId, pedidoItemId, baseCalculo, valorComissao, status)
    VALUES ('2026-07', ?, 1, 1, 1000, 50, 'pendente')`).run(id);
  const d = regras.diagnostico(db, { agora: '2026-08-02T12:00:00Z' });
  assert(d.comissaoPendentePorVendedorInativo.length === 1, JSON.stringify(d.comissaoPendentePorVendedorInativo));
  assert(d.comissaoPendentePorVendedorInativo[0].valor === 50, JSON.stringify(d.comissaoPendentePorVendedorInativo));
});

t('conta usuários por perfil', () => {
  limpar();
  novoUsuario({ username: 'a', role: 'admin' });
  novoUsuario({ username: 'b', role: 'financeiro' });
  novoUsuario({ username: 'c', role: 'financeiro' });
  const porRole = Object.fromEntries(regras.diagnostico(db).porRole.map((x) => [x.role, x.n]));
  assert(porRole.financeiro === 2 && porRole.admin === 1, JSON.stringify(porRole));
});

// ==================== IMPACTO DA DESATIVAÇÃO ====================
console.log('\n--- impacto de desativar ---');

t('sem pendências o impacto vem vazio', () => {
  limpar();
  const id = novoUsuario({ username: 'zé' });
  const i = regras.impactoDesativacao(db, id);
  assert(i.pendencias.length === 0 && i.ficariaSemAdmin === false, JSON.stringify(i));
});

t('comissão pendente aparece como pendência', () => {
  limpar();
  const id = novoUsuario({ username: 'vend', ehVendedor: 1 });
  db.prepare(`INSERT INTO comissoes_apuracao
    (periodo, vendedorId, pedidoId, pedidoItemId, baseCalculo, valorComissao, status)
    VALUES ('2026-07', ?, 1, 1, 1000, 50, 'pendente')`).run(id);
  const i = regras.impactoDesativacao(db, id);
  assert(i.pendencias.some((x) => /comiss/i.test(x.rotulo) && x.n === 1), JSON.stringify(i.pendencias));
});

t('desativar o único admin é sinalizado', () => {
  limpar();
  const id = novoUsuario({ username: 'chefe', role: 'admin' });
  assert(regras.impactoDesativacao(db, id).ficariaSemAdmin === true, 'não sinalizou');
});

t('com outro admin ativo, não sinaliza', () => {
  const id = db.prepare("SELECT id FROM users WHERE username = 'chefe'").get().id;
  novoUsuario({ username: 'chefe2', role: 'admin' });
  assert(regras.impactoDesativacao(db, id).ficariaSemAdmin === false, 'sinalizou à toa');
});

t('a rota de desativar avisa o que ficou órfão', () => {
  limpar();
  USUARIO_REQ = { id: 999, role: 'admin', username: 'admin' };
  const id = novoUsuario({ username: 'vend', ehVendedor: 1 });
  db.prepare(`INSERT INTO comissoes_apuracao
    (periodo, vendedorId, pedidoId, pedidoItemId, baseCalculo, valorComissao, status)
    VALUES ('2026-07', ?, 1, 1, 1000, 50, 'pendente')`).run(id);
  const r = call('delete', '/api/usuarios/:id', {}, { id: String(id) });
  assert(r.body.success, JSON.stringify(r.body));
  assert(/trabalho em aberto/i.test(r.body.aviso || ''), 'aviso: ' + r.body.aviso);
  assert(db.prepare('SELECT ativo FROM users WHERE id = ?').get(id).ativo === 0, 'não desativou');
});

t('desativar a si mesmo continua bloqueado', () => {
  limpar();
  const id = novoUsuario({ username: 'admin', role: 'admin' });
  USUARIO_REQ = { id, role: 'admin', username: 'admin' };
  const r = call('delete', '/api/usuarios/:id', {}, { id: String(id) });
  assert(r.status === 400, 'status: ' + r.status);
  assert(db.prepare('SELECT ativo FROM users WHERE id = ?').get(id).ativo === 1, 'desativou a si mesmo');
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
