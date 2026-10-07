#!/usr/bin/env node
'use strict';
/**
 * test-suporte-fundacao.js — a Fase 1 da Central de Suporte.
 *
 *   node scripts/test-suporte-fundacao.js
 *
 * O que esta suíte existe para provar: os chamados de todas as empresas moram
 * na MESMA tabela do control.db, e o que as mantém separadas é só código. Toda
 * checagem aqui aponta para esse ponto.
 *
 * O banco é um control.db DESCARTÁVEL, criado do zero em /tmp a cada rodada.
 * Nada toca `data/control.db`: a suíte monta as tabelas mínimas de `tenants` e
 * `super_admins` (as que o schema de suporte referencia por chave estrangeira)
 * e chama o `ensureSuporteSchema` de verdade, o mesmo que o boot chama.
 *
 *  A. schema                      F. nota interna é estrutural
 *  B. categorias idempotentes     G. histórico registra
 *  C. abrir chamado               H. tenant inválido falha fechado
 *  D. isolamento entre empresas   I. a equipe atravessa de propósito
 *  E. mensagens no chamado certo  J. nenhuma consulta de cliente vaza o resto
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const { ensureSuporteSchema, CATEGORIAS_SEED } = require(path.join(RAIZ, 'suporte-schema'));
const repo = require(path.join(RAIZ, 'suporte-repo'));

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try { fn(); console.log('  ok    ' + nome); ok++; }
  catch (e) { console.log('  FALHA ' + nome + '\n          ' + e.message); fail++; }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suporte-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* já saiu */ } });

/** Um control.db novo, com só o que o schema de suporte referencia. */
function bancoNovo() {
  const db = new Database(path.join(dir, 'control-' + Math.random().toString(36).slice(2) + '.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'TRIAL',
      db_path TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE super_admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, name TEXT, created_at INTEGER NOT NULL);
  `);
  const agora = Date.now();
  const insT = db.prepare('INSERT INTO tenants (slug,name,db_path,created_at) VALUES (?,?,?,?)');
  const A = Number(insT.run('empresa-a', 'Empresa A', '/x/a.db', agora).lastInsertRowid);
  const B = Number(insT.run('empresa-b', 'Empresa B', '/x/b.db', agora).lastInsertRowid);
  const adminId = Number(db.prepare('INSERT INTO super_admins (email,password_hash,name,created_at) VALUES (?,?,?,?)')
    .run('suporte@liciteagora.com.br', 'x', 'Atendente', agora).lastInsertRowid);
  ensureSuporteSchema(db);
  return { db, A, B, adminId };
}

const catPadrao = (db) => repo.listarCategoriasAtivas(db)[0];

console.log('\n== A. schema ==');
{
  const { db } = bancoNovo();
  t('A1 as quatro tabelas existem', () => {
    const nomes = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'suporte_%'")
      .all().map((x) => x.name).sort();
    assert.deepStrictEqual(nomes,
      ['suporte_categorias', 'suporte_chamados', 'suporte_historico', 'suporte_mensagens']);
  });
  t('A2 rodar o schema de novo não quebra nem duplica', () => {
    const antes = db.prepare('SELECT COUNT(*) n FROM suporte_categorias').get().n;
    ensureSuporteSchema(db);
    ensureSuporteSchema(db);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM suporte_categorias').get().n, antes);
  });
  t('A3 os índices de isolamento existem', () => {
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_suporte_%'")
      .all().map((x) => x.name);
    assert.ok(idx.includes('idx_suporte_chamados_tenant'), 'falta o índice por tenant: ' + idx.join(','));
    assert.ok(idx.includes('idx_suporte_mensagens_chamado'), 'falta o índice de mensagens');
  });
  t('A4 tenant_id é NOT NULL e aponta para tenants', () => {
    const col = db.prepare("SELECT * FROM pragma_table_info('suporte_chamados') WHERE name='tenant_id'").get();
    assert.strictEqual(col.notnull, 1, 'tenant_id precisa ser NOT NULL');
    const fk = db.prepare("SELECT * FROM pragma_foreign_key_list('suporte_chamados')").all()
      .find((f) => f.from === 'tenant_id');
    assert.ok(fk && fk.table === 'tenants', 'tenant_id tem de referenciar tenants');
    assert.strictEqual(fk.on_delete, 'RESTRICT', 'o histórico não pode sumir com o tenant');
  });
  t('A5 o banco recusa chamado sem tenant', () => {
    assert.throws(() => db.prepare(`INSERT INTO suporte_chamados
      (numero,assunto,descricao,created_at,updated_at) VALUES ('x','a','b',1,1)`).run());
  });
  t('A6 o banco recusa tenant inexistente (chave estrangeira ligada)', () => {
    assert.throws(() => db.prepare(`INSERT INTO suporte_chamados
      (tenant_id,numero,assunto,descricao,created_at,updated_at) VALUES (9999,'y','a','b',1,1)`).run(),
    /FOREIGN KEY/i);
  });
  db.close();
}

console.log('\n== B. categorias ==');
{
  const { db } = bancoNovo();
  t('B1 as sete categorias entram', () => {
    assert.strictEqual(repo.listarCategoriasAtivas(db).length, CATEGORIAS_SEED.length);
  });
  t('B2 o seed não sobrescreve edição do administrador', () => {
    db.prepare("UPDATE suporte_categorias SET nome = 'Dúvida (editado)', sla_horas = 99 WHERE slug = 'duvida'").run();
    ensureSuporteSchema(db);
    const c = db.prepare("SELECT * FROM suporte_categorias WHERE slug = 'duvida'").get();
    assert.strictEqual(c.nome, 'Dúvida (editado)', 'o seed sobrescreveu o que o admin editou');
    assert.strictEqual(c.sla_horas, 99);
  });
  t('B3 categoria inativa não é oferecida', () => {
    db.prepare("UPDATE suporte_categorias SET ativo = 0 WHERE slug = 'outro'").run();
    assert.ok(!repo.listarCategoriasAtivas(db).some((c) => c.slug === 'outro'));
  });
  db.close();
}

console.log('\n== C. abrir chamado ==');
{
  const { db, A } = bancoNovo();
  t('C1 abre e devolve número', () => {
    const r = repo.criarChamadoDoTenant(db, A, {
      assunto: 'NF-e não autoriza', descricao: 'Rejeição 539 desde ontem',
      categoriaId: catPadrao(db).id, abertoPorUserId: 7, abertoPorNome: 'Ana',
    });
    assert.ok(r.id > 0);
    assert.match(r.numero, /^\d{4}-\d{4}$/, 'número fora do padrão ANO-0001: ' + r.numero);
  });
  t('C2 a categoria define prioridade e prazo quando não vêm', () => {
    const cat = repo.listarCategoriasAtivas(db).find((c) => c.slug === 'problema-tecnico');
    const r = repo.criarChamadoDoTenant(db, A, { assunto: 'x', descricao: 'y', categoriaId: cat.id });
    const ch = repo.buscarChamadoDoTenant(db, A, r.id);
    assert.strictEqual(ch.prioridade, cat.prioridade_padrao);
    assert.ok(ch.sla_vence_at > Date.now(), 'o prazo não foi calculado a partir da categoria');
  });
  t('C3 nasce aberto, sem responsável', () => {
    const r = repo.criarChamadoDoTenant(db, A, { assunto: 'z', descricao: 'w' });
    const ch = repo.buscarChamadoDoTenant(db, A, r.id);
    assert.strictEqual(ch.status, 'aberto');
    assert.strictEqual(ch.responsavel_admin_id, null);
  });
  t('C4 assunto vazio é recusado', () => {
    assert.throws(() => repo.criarChamadoDoTenant(db, A, { assunto: '  ', descricao: 'x' }), /assunto/i);
  });
  /* A prioridade mandada por quem abre é IGNORADA, não recusada. Recusar
     daria ao cliente a informação de que o campo existe e vale a pena tentar;
     ignorar silenciosamente é o que queremos, e o chamado sai com a
     prioridade da categoria como se nada tivesse sido enviado. */
  t('C5 prioridade enviada por quem abre é ignorada', () => {
    const cat = repo.listarCategoriasAtivas(db).find((c) => c.slug === 'sugestao');
    const r = repo.criarChamadoDoTenant(db, A, {
      assunto: 'a', descricao: 'b', categoriaId: cat.id, prioridade: 'urgente',
    });
    const ch = repo.buscarChamadoDoTenant(db, A, r.id);
    assert.strictEqual(ch.prioridade, cat.prioridade_padrao,
      'a prioridade enviada venceu a da categoria');
    assert.notStrictEqual(ch.prioridade, 'urgente', 'o cliente conseguiu se marcar como urgente');
  });
  t('C5b nem com prioridade inventada, nem sem categoria', () => {
    const r = repo.criarChamadoDoTenant(db, A,
      { assunto: 'c', descricao: 'd', prioridade: 'altissima' });
    assert.strictEqual(repo.buscarChamadoDoTenant(db, A, r.id).prioridade, 'normal',
      'sem categoria a prioridade tem de cair no padrão, não no que veio de fora');
  });
  db.close();
}

console.log('\n== D. isolamento entre empresas ==');
{
  const { db, A, B } = bancoNovo();
  const daA = repo.criarChamadoDoTenant(db, A, { assunto: 'Só da A', descricao: 'confidencial' });
  const daB = repo.criarChamadoDoTenant(db, B, { assunto: 'Só da B', descricao: 'confidencial' });

  t('D1 a empresa acha o próprio chamado', () => {
    assert.strictEqual(repo.buscarChamadoDoTenant(db, A, daA.id).assunto, 'Só da A');
  });
  t('D2 a empresa NÃO acha o chamado da outra', () => {
    assert.strictEqual(repo.buscarChamadoDoTenant(db, B, daA.id), null,
      'a empresa B enxergou o chamado da A');
  });
  t('D3 o alheio é tratado como inexistente, não como proibido', () => {
    const alheio = repo.buscarChamadoDoTenant(db, B, daA.id);
    const inexistente = repo.buscarChamadoDoTenant(db, B, 999999);
    assert.strictEqual(alheio, inexistente,
      'id alheio e id inexistente têm de dar a MESMA resposta, senão a diferença denuncia');
  });
  t('D4 a lista de cada empresa traz só a dela', () => {
    const listaA = repo.listarChamadosDoTenant(db, A);
    const listaB = repo.listarChamadosDoTenant(db, B);
    assert.strictEqual(listaA.length, 1);
    assert.strictEqual(listaB.length, 1);
    assert.ok(listaA.every((c) => c.tenant_id === A), 'vazou chamado de outra empresa na lista da A');
    assert.ok(listaB.every((c) => c.tenant_id === B), 'vazou chamado de outra empresa na lista da B');
  });
  t('D5 responder chamado alheio não escreve nada', () => {
    const r = repo.responderChamadoDoTenant(db, B, daA.id, { corpo: 'invasão' });
    assert.strictEqual(r, null, 'a empresa B conseguiu responder no chamado da A');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM suporte_mensagens WHERE chamado_id = ?')
      .get(daA.id).n, 0, 'uma mensagem foi gravada no chamado alheio');
  });
  t('D6 ler mensagens de chamado alheio devolve nulo', () => {
    assert.strictEqual(repo.listarMensagensDoTenant(db, B, daA.id), null);
  });
  t('D7 não existe função de cliente sem tenant no módulo', () => {
    const exportadas = Object.keys(repo).filter((k) => typeof repo[k] === 'function');
    const suspeitas = exportadas.filter((k) => /^(buscar|listar|responder|criar)/.test(k)
      && !/DoTenant$/.test(k) && k !== 'listarCategoriasAtivas');
    assert.deepStrictEqual(suspeitas, [],
      'função de leitura sem o sufixo DoTenant exportada no nível de cima: ' + suspeitas.join(', '));
  });
  db.close();
}

console.log('\n== E. mensagens ==');
{
  const { db, A, B } = bancoNovo();
  const c1 = repo.criarChamadoDoTenant(db, A, { assunto: 'um', descricao: 'd' });
  const c2 = repo.criarChamadoDoTenant(db, A, { assunto: 'dois', descricao: 'd' });
  repo.criarChamadoDoTenant(db, B, { assunto: 'da B', descricao: 'd' });

  t('E1 a mensagem fica no chamado certo', () => {
    repo.responderChamadoDoTenant(db, A, c1.id, { corpo: 'mensagem do um', autorNome: 'Ana' });
    const m1 = repo.listarMensagensDoTenant(db, A, c1.id);
    const m2 = repo.listarMensagensDoTenant(db, A, c2.id);
    assert.strictEqual(m1.length, 1);
    assert.strictEqual(m1[0].corpo, 'mensagem do um');
    assert.strictEqual(m2.length, 0, 'a mensagem apareceu no chamado errado');
  });
  t('E2 responder devolve o chamado para a equipe', () => {
    const { db: d2, A: a2, adminId } = bancoNovo();
    const c = repo.criarChamadoDoTenant(d2, a2, { assunto: 'x', descricao: 'y' });
    repo.admin.responder(d2, c.id, { corpo: 'oi', adminId });
    assert.strictEqual(repo.buscarChamadoDoTenant(d2, a2, c.id).status, 'aguardando_cliente');
    repo.responderChamadoDoTenant(d2, a2, c.id, { corpo: 'obrigado' });
    assert.strictEqual(repo.buscarChamadoDoTenant(d2, a2, c.id).status, 'em_atendimento');
    d2.close();
  });
  t('E3 chamado encerrado recusa resposta do cliente', () => {
    repo.admin.mudarStatus(db, c1.id, 'encerrado');
    assert.throws(() => repo.responderChamadoDoTenant(db, A, c1.id, { corpo: 'mais uma' }), /encerrado/i);
  });
  db.close();
}

console.log('\n== F. nota interna ==');
{
  const { db, A, adminId } = bancoNovo();
  const c = repo.criarChamadoDoTenant(db, A, { assunto: 'com nota', descricao: 'd' });
  repo.admin.responder(db, c.id, { corpo: 'PÚBLICA: estamos vendo', adminId });
  repo.admin.responder(db, c.id, { corpo: 'INTERNA: cliente atrasado no boleto', adminId, interna: true });

  t('F1 a equipe vê as duas', () => {
    assert.strictEqual(repo.admin.listarMensagens(db, c.id).length, 2);
  });
  t('F2 o cliente NÃO vê a interna', () => {
    const vistas = repo.listarMensagensDoTenant(db, A, c.id);
    assert.strictEqual(vistas.length, 1, 'a nota interna vazou para o cliente');
    assert.ok(!vistas.some((m) => /INTERNA/.test(m.corpo)), 'texto da nota interna chegou ao cliente');
  });
  t('F3 a coluna identifica a nota, não o texto', () => {
    const interna = db.prepare('SELECT * FROM suporte_mensagens WHERE interna = 1').get();
    assert.ok(interna, 'nenhuma mensagem marcada como interna');
    assert.strictEqual(interna.autor_tipo, 'equipe');
  });
  t('F4 o BANCO recusa nota interna de cliente', () => {
    assert.throws(() => db.prepare(`INSERT INTO suporte_mensagens
      (chamado_id,autor_tipo,corpo,interna,created_at) VALUES (?, 'cliente', 'x', 1, ?)`)
      .run(c.id, Date.now()), /CHECK/i);
  });
  t('F5 nota interna não muda o estado do chamado', () => {
    const { db: d2, A: a2, adminId: ad2 } = bancoNovo();
    const ch = repo.criarChamadoDoTenant(d2, a2, { assunto: 'x', descricao: 'y' });
    repo.admin.responder(d2, ch.id, { corpo: 'nota', adminId: ad2, interna: true });
    assert.strictEqual(repo.buscarChamadoDoTenant(d2, a2, ch.id).status, 'aberto',
      'a nota interna mexeu no status e o cliente ficaria esperando uma resposta que não viu');
    d2.close();
  });
  db.close();
}

console.log('\n== G. histórico ==');
{
  const { db, A, adminId } = bancoNovo();
  const c = repo.criarChamadoDoTenant(db, A, { assunto: 'h', descricao: 'd', abertoPorNome: 'Ana' });
  repo.admin.responder(db, c.id, { corpo: 'resposta', adminId, adminNome: 'Suporte' });
  repo.admin.mudarStatus(db, c.id, 'resolvido', { id: adminId, nome: 'Suporte' });
  repo.admin.atribuir(db, c.id, adminId, { id: adminId, nome: 'Suporte' });

  t('G1 cada ação deixou linha', () => {
    const acoes = repo.admin.historico(db, c.id).map((h) => h.action);
    for (const esperada of ['aberto', 'mensagem_equipe', 'status', 'atribuido']) {
      assert.ok(acoes.includes(esperada), 'falta "' + esperada + '" no histórico: ' + acoes.join(', '));
    }
  });
  /* O "de" é `aguardando_cliente`, e não `aberto`: a resposta da equipe no
     setup já moveu o chamado. É exatamente isso que o histórico precisa
     registrar — a transição que aconteceu, não a que se supunha. */
  t('G2 a mudança de status guarda de onde para onde', () => {
    const h = repo.admin.historico(db, c.id).find((x) => x.action === 'status');
    assert.deepStrictEqual(JSON.parse(h.payload), { de: 'aguardando_cliente', para: 'resolvido' });
  });
  t('G2b a resposta da equipe também deixou a transição registrada', () => {
    const transicoes = repo.admin.historico(db, c.id)
      .filter((x) => x.action === 'mensagem_equipe').length;
    assert.strictEqual(transicoes, 1);
    assert.strictEqual(repo.buscarChamadoDoTenant(db, A, c.id).primeira_resposta_at > 0, true,
      'a primeira resposta não foi carimbada');
  });
  t('G3 resolvido_at foi carimbado', () => {
    assert.ok(repo.buscarChamadoDoTenant(db, A, c.id).resolvido_at > 0);
  });
  db.close();
}

console.log('\n== H. tenant inválido falha fechado ==');
{
  const { db, A } = bancoNovo();
  repo.criarChamadoDoTenant(db, A, { assunto: 'existe', descricao: 'd' });

  for (const [rotulo, valor] of [['undefined', undefined], ['null', null], ['zero', 0],
    ['negativo', -1], ['texto', 'abc'], ['objeto', {}], ['NaN', NaN]]) {
    t('H1 listar com tenant ' + rotulo + ' é recusado, e não devolve tudo', () => {
      assert.throws(() => repo.listarChamadosDoTenant(db, valor), /tenantId obrigatório/);
    });
  }
  t('H2 abrir chamado para tenant que não existe é recusado', () => {
    assert.throws(() => repo.criarChamadoDoTenant(db, 4242, { assunto: 'a', descricao: 'b' }),
      /tenant inexistente/);
  });
  t('H3 SQL injection no tenantId não passa', () => {
    assert.throws(() => repo.listarChamadosDoTenant(db, '1 OR 1=1'), /tenantId obrigatório/);
  });
  db.close();
}

console.log('\n== I. a equipe atravessa de propósito ==');
{
  const { db, A, B, adminId } = bancoNovo();
  repo.criarChamadoDoTenant(db, A, { assunto: 'da A', descricao: 'd' });
  const b1 = repo.criarChamadoDoTenant(db, B, { assunto: 'da B', descricao: 'd' });

  t('I1 a fila da equipe vê as duas empresas', () => {
    const fila = repo.admin.listarChamados(db);
    assert.strictEqual(fila.length, 2);
    assert.deepStrictEqual([...new Set(fila.map((c) => c.tenant_slug))].sort(), ['empresa-a', 'empresa-b']);
  });
  t('I2 a fila diz de que empresa é cada chamado', () => {
    assert.ok(repo.admin.listarChamados(db).every((c) => c.tenant_nome));
  });
  t('I3 filtro "sem resposta" usa a mensagem, não um campo', () => {
    assert.strictEqual(repo.admin.listarChamados(db, { semResposta: true }).length, 2);
    repo.admin.responder(db, b1.id, { corpo: 'respondido', adminId });
    assert.strictEqual(repo.admin.listarChamados(db, { semResposta: true }).length, 1);
  });
  t('I4 nota interna NÃO conta como resposta ao cliente', () => {
    const { db: d2, A: a2, adminId: ad2 } = bancoNovo();
    const c = repo.criarChamadoDoTenant(d2, a2, { assunto: 'x', descricao: 'y' });
    repo.admin.responder(d2, c.id, { corpo: 'só nota', adminId: ad2, interna: true });
    assert.strictEqual(repo.admin.listarChamados(d2, { semResposta: true }).length, 1,
      'a nota interna fez o chamado sumir da fila de "sem resposta"');
    d2.close();
  });
  t('I5 atribuir grava o responsável', () => {
    repo.admin.atribuir(db, b1.id, adminId);
    assert.strictEqual(repo.admin.buscarChamado(db, b1.id).responsavel_admin_id, adminId);
  });
  t('I6 atribuir a admin inexistente é recusado', () => {
    assert.throws(() => repo.admin.atribuir(db, b1.id, 777), /responsável inexistente/);
  });
  db.close();
}

console.log('\n== J. nenhuma consulta de cliente vaza o resto ==');
{
  const { db, A, B } = bancoNovo();
  for (let i = 0; i < 5; i++) repo.criarChamadoDoTenant(db, A, { assunto: 'A' + i, descricao: 'd' });
  for (let i = 0; i < 4; i++) repo.criarChamadoDoTenant(db, B, { assunto: 'B' + i, descricao: 'd' });

  t('J1 com 9 chamados no banco, cada empresa só vê os seus', () => {
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM suporte_chamados').get().n, 9);
    assert.strictEqual(repo.listarChamadosDoTenant(db, A).length, 5);
    assert.strictEqual(repo.listarChamadosDoTenant(db, B).length, 4);
  });
  t('J2 filtros do cliente não afrouxam o tenant', () => {
    for (const f of [{ status: 'aberto' }, { abertos: true }, { limite: 100 }, { abertoPorUserId: null }]) {
      const r = repo.listarChamadosDoTenant(db, A, f);
      assert.ok(r.every((c) => c.tenant_id === A),
        'o filtro ' + JSON.stringify(f) + ' trouxe chamado de outra empresa');
    }
  });
  t('J3 varrer todos os ids pelo lado do cliente só devolve os da empresa', () => {
    const achados = [];
    for (let id = 1; id <= 12; id++) {
      const c = repo.buscarChamadoDoTenant(db, B, id);
      if (c) achados.push(c.tenant_id);
    }
    assert.strictEqual(achados.length, 4, 'a enumeração de ids achou ' + achados.length + ' chamados para a B');
    assert.ok(achados.every((x) => x === B), 'a enumeração alcançou outra empresa');
  });
  db.close();
}

console.log(`\n${fail === 0 ? 'TODOS OS CASOS PASSARAM' : fail + ' CASO(S) REPROVARAM'}  (${ok} ok, ${fail} falhas)`);
process.exit(fail === 0 ? 0 : 1);
