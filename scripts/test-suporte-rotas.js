#!/usr/bin/env node
'use strict';
/**
 * test-suporte-rotas.js — a Fase 2 da Central de Suporte, medida por HTTP.
 *
 *   node scripts/test-suporte-rotas.js
 *
 * A Fase 1 provou o isolamento no repositório. Esta suíte prova o mesmo pela
 * porta por onde o ataque entraria: a requisição. Sobe um Express de verdade
 * com `registrarRotasSuporte`, duas empresas, quatro usuários e um control.db
 * descartável. Nada toca `data/`.
 *
 * O que o servidor de teste reproduz da produção, e por quê:
 *   - `req.tenant` vem do HOST simulado, nunca do corpo. É o ponto do ataque
 *     "mando tenant_id no JSON" — e a prova de que não adianta;
 *   - `req.user` vem da "sessão", e o perfil sai de uma tabela `perfis_acesso`
 *     igual à do tenant, para `acessoDoUsuario` decidir de verdade.
 *
 *  A. sessão e contexto      E. nota interna nunca sai
 *  B. abrir chamado          F. responder e reabrir
 *  C. prioridade blindada    G. XSS não vira marcação
 *  D. isolamento por HTTP    H. comum x administrador da empresa
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const { ensureSuporteSchema } = require(path.join(RAIZ, 'suporte-schema'));
const repo = require(path.join(RAIZ, 'suporte-repo'));
const { registrarRotasSuporte } = require(path.join(RAIZ, 'suporte-routes'));

let ok = 0, fail = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  ok    ' + nome); ok++; }
  catch (e) { console.log('  FALHA ' + nome + '\n          ' + e.message); fail++; }
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suporte-rotas-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* já saiu */ } });

(async () => {
  const express = require(path.join(RAIZ, 'node_modules/express'));

  // ── control.db descartável, com as duas empresas ──────────────────────────
  const controlDb = new Database(path.join(dir, 'control.db'));
  controlDb.pragma('foreign_keys = ON');
  controlDb.exec(`
    CREATE TABLE tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'TRIAL', db_path TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    CREATE TABLE super_admins (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, name TEXT, created_at INTEGER NOT NULL);
  `);
  const agora = Date.now();
  const insT = controlDb.prepare('INSERT INTO tenants (slug,name,db_path,created_at) VALUES (?,?,?,?)');
  const EMPRESA_A = Number(insT.run('empresa-a', 'Empresa A', '/x/a.db', agora).lastInsertRowid);
  const EMPRESA_B = Number(insT.run('empresa-b', 'Empresa B', '/x/b.db', agora).lastInsertRowid);
  const adminId = Number(controlDb.prepare(
    'INSERT INTO super_admins (email,password_hash,name,created_at) VALUES (?,?,?,?)')
    .run('sup@liciteagora.com.br', 'x', 'Suporte', agora).lastInsertRowid);
  ensureSuporteSchema(controlDb);

  /* O banco do TENANT. Só serve para `acessoDoUsuario` ler o perfil — nenhum
     chamado mora aqui. O perfil 'operador' é restrito de propósito: é ele que
     faz o usuário comum ver só os próprios chamados. */
  const tenantDb = new Database(path.join(dir, 'tenant.db'));
  tenantDb.exec(`
    CREATE TABLE perfis_acesso (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
      nome TEXT NOT NULL, paginas TEXT, ativo INTEGER NOT NULL DEFAULT 1);
  `);
  tenantDb.prepare("INSERT INTO perfis_acesso (slug,nome,paginas,ativo) VALUES ('operador','Operador',?,1)")
    .run(JSON.stringify(['suporte-chamados', 'suporte-novo']));

  const ANA   = { id: 11, username: 'ana',   nome: 'Ana',   role: 'operador' };  // comum, empresa A
  const BRUNO = { id: 12, username: 'bruno', nome: 'Bruno', role: 'operador' };  // comum, empresa A
  const CHEFE = { id: 13, username: 'chefe', nome: 'Chefe', role: 'admin' };     // admin da empresa A
  const DORA  = { id: 21, username: 'dora',  nome: 'Dora',  role: 'operador' };  // comum, empresa B
  /* SEM PERFIL: o `role` não tem cadastro em `perfis_acesso`. O ERP trata
     isso como irrestrito (fail-open); a Central, não. */
  const ZECA  = { id: 14, username: 'zeca',  nome: 'Zeca',  role: 'financeiro' };

  // ── o servidor ────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());

  let SESSAO = null;   // quem está logado agora
  let HOST = null;     // a empresa do host, como o tenant-middleware resolveria

  app.use((req, _res, next) => {
    /* O tenant vem do HOST. Mesmo que a requisição mande `tenant_id` no corpo
       ou na query, ele não é lido em lugar nenhum — é o que os casos D5/D6
       provam. */
    if (HOST) req.tenant = HOST;
    if (SESSAO) req.user = SESSAO;
    next();
  });
  registrarRotasSuporte(app, tenantDb, controlDb);

  const srv = app.listen(0);
  const porta = srv.address().port;
  const base = 'http://127.0.0.1:' + porta;

  /** Faz a requisição como `user`, no host de `tenant`. */
  const como = (user, tenant) => { SESSAO = user; HOST = tenant; };
  const pedir = async (metodo, caminho, corpo) => {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: corpo ? { 'Content-Type': 'application/json' } : {},
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch (_) { /* sem corpo */ }
    return { status: r.status, json };
  };
  const T_A = { id: EMPRESA_A, slug: 'empresa-a', name: 'Empresa A' };
  const T_B = { id: EMPRESA_B, slug: 'empresa-b', name: 'Empresa B' };

  const catDe = (slug) => repo.listarCategoriasAtivas(controlDb).find((c) => c.slug === slug);

  // ══ A. sessão e contexto ══════════════════════════════════════════════════
  console.log('\n== A. sessão e contexto ==');
  await t('A1 sem sessão é negado (401)', async () => {
    como(null, T_A);
    const r = await pedir('GET', '/api/suporte/chamados');
    assert.strictEqual(r.status, 401, 'respondeu ' + r.status + ' sem usuário logado');
  });
  await t('A2 sem tenant no host é recusado (400)', async () => {
    como(ANA, null);
    const r = await pedir('GET', '/api/suporte/chamados');
    assert.strictEqual(r.status, 400);
  });
  await t('A3 com sessão e host, responde', async () => {
    como(ANA, T_A);
    const r = await pedir('GET', '/api/suporte/chamados');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.chamados));
  });
  await t('A4 categorias exigem sessão', async () => {
    como(null, T_A);
    assert.strictEqual((await pedir('GET', '/api/suporte/categorias')).status, 401);
    como(ANA, T_A);
    const r = await pedir('GET', '/api/suporte/categorias');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.categorias.length, 7);
  });

  // ══ B. abrir chamado ══════════════════════════════════════════════════════
  console.log('\n== B. abrir chamado ==');
  let chamadoAna = null;
  await t('B1 usuário autenticado abre chamado', async () => {
    como(ANA, T_A);
    const r = await pedir('POST', '/api/suporte/chamados', {
      categoriaId: catDe('duvida').id, assunto: 'Como emitir NF-e?', descricao: 'Não acho o botão',
    });
    assert.strictEqual(r.status, 201, 'status ' + r.status + ': ' + JSON.stringify(r.json));
    assert.match(r.json.chamado.numero, /^\d{4}-\d{4}$/);
    chamadoAna = r.json.chamado.id;
  });
  await t('B2 assunto vazio é 400, não 500', async () => {
    como(ANA, T_A);
    const r = await pedir('POST', '/api/suporte/chamados', { assunto: '  ', descricao: 'x' });
    assert.strictEqual(r.status, 400);
  });
  await t('B3 categoria inexistente é recusada', async () => {
    como(ANA, T_A);
    const r = await pedir('POST', '/api/suporte/chamados',
      { categoriaId: 9999, assunto: 'a', descricao: 'b' });
    assert.strictEqual(r.status, 400);
  });
  await t('B4 categoria inativa é recusada', async () => {
    const c = catDe('outro');
    controlDb.prepare('UPDATE suporte_categorias SET ativo = 0 WHERE id = ?').run(c.id);
    como(ANA, T_A);
    const r = await pedir('POST', '/api/suporte/chamados',
      { categoriaId: c.id, assunto: 'a', descricao: 'b' });
    controlDb.prepare('UPDATE suporte_categorias SET ativo = 1 WHERE id = ?').run(c.id);
    assert.strictEqual(r.status, 400, 'categoria inativa passou');
  });
  await t('B5 a resposta não expõe campo interno', async () => {
    como(ANA, T_A);
    const r = await pedir('GET', '/api/suporte/chamados/' + chamadoAna);
    const txt = JSON.stringify(r.json);
    for (const proibido of ['tenant_id', 'aberto_por_user_id', 'responsavel_admin_id', 'interna', 'payload']) {
      assert.ok(!txt.includes(proibido), 'a resposta vazou "' + proibido + '"');
    }
  });

  // ══ C. prioridade blindada ════════════════════════════════════════════════
  console.log('\n== C. prioridade blindada ==');
  await t('C1 prioridade enviada pelo browser é ignorada', async () => {
    como(ANA, T_A);
    const r = await pedir('POST', '/api/suporte/chamados', {
      categoriaId: catDe('sugestao').id, assunto: 'Quero isso urgente',
      descricao: 'tentando forçar', prioridade: 'urgente',
    });
    assert.strictEqual(r.status, 201);
    const linha = controlDb.prepare('SELECT prioridade FROM suporte_chamados WHERE id = ?')
      .get(r.json.chamado.id);
    assert.strictEqual(linha.prioridade, catDe('sugestao').prioridade_padrao,
      'o cliente conseguiu escolher a prioridade');
    assert.notStrictEqual(linha.prioridade, 'urgente');
  });
  await t('C2 a categoria é quem define a prioridade', async () => {
    como(ANA, T_A);
    const r = await pedir('POST', '/api/suporte/chamados', {
      categoriaId: catDe('problema-tecnico').id, assunto: 'Sistema fora', descricao: 'erro 500',
    });
    const linha = controlDb.prepare('SELECT prioridade FROM suporte_chamados WHERE id = ?')
      .get(r.json.chamado.id);
    assert.strictEqual(linha.prioridade, catDe('problema-tecnico').prioridade_padrao);
  });
  await t('C3 a prioridade nem aparece na resposta ao cliente', async () => {
    como(ANA, T_A);
    const r = await pedir('GET', '/api/suporte/chamados/' + chamadoAna);
    assert.ok(!JSON.stringify(r.json).includes('prioridade'),
      'a prioridade foi exposta e vira alvo de manipulação');
  });

  /* ══ D. isolamento por HTTP ═════════════════════════════════════════════
     Estes casos usam o CHEFE (admin da empresa A), e não a Ana, de propósito.
     O usuário comum é barrado por DUAS camadas — o tenant e o dono do chamado
     —, e com as duas ligadas uma sabotagem no filtro de tenant passaria
     despercebida: a segunda camada devolveria 404 do mesmo jeito. Quem é
     irrestrito só tem a camada do tenant entre ele e a outra empresa, e é
     exatamente essa que aqui precisa ser provada. (Descoberto na sabotagem 1:
     com a Ana, retirar o filtro de tenant reprovava um caso só.) */
  console.log('\n== D. isolamento por HTTP ==');
  let chamadoDora = null;
  await t('D1 a empresa B abre o seu', async () => {
    como(DORA, T_B);
    const r = await pedir('POST', '/api/suporte/chamados',
      { categoriaId: catDe('fiscal').id, assunto: 'Segredo da B', descricao: 'confidencial' });
    assert.strictEqual(r.status, 201);
    chamadoDora = r.json.chamado.id;
  });
  await t('D2 A (admin, irrestrito) recebe 404 no chamado de B', async () => {
    como(CHEFE, T_A);
    const r = await pedir('GET', '/api/suporte/chamados/' + chamadoDora);
    assert.strictEqual(r.status, 404, 'status ' + r.status + ' — tinha de ser 404');
  });
  await t('D3 404 de alheio é idêntico ao de inexistente', async () => {
    como(CHEFE, T_A);
    const alheio = await pedir('GET', '/api/suporte/chamados/' + chamadoDora);
    const nunca = await pedir('GET', '/api/suporte/chamados/99999');
    assert.strictEqual(alheio.status, nunca.status);
    assert.deepStrictEqual(alheio.json, nunca.json,
      'a resposta difere e denuncia que o id existe');
  });
  await t('D4 nada do chamado alheio vaza na resposta', async () => {
    como(CHEFE, T_A);
    const r = await pedir('GET', '/api/suporte/chamados/' + chamadoDora);
    const txt = JSON.stringify(r.json);
    for (const vazamento of ['Segredo da B', 'confidencial', 'empresa-b', 'Empresa B']) {
      assert.ok(!txt.includes(vazamento), 'vazou "' + vazamento + '"');
    }
  });
  await t('D5 tenant_id no CORPO não muda a dona do chamado', async () => {
    como(CHEFE, T_A);
    const r = await pedir('POST', '/api/suporte/chamados', {
      categoriaId: catDe('duvida').id, assunto: 'tentando trocar de dono',
      descricao: 'x', tenant_id: EMPRESA_B, tenantId: EMPRESA_B,
    });
    assert.strictEqual(r.status, 201);
    const linha = controlDb.prepare('SELECT tenant_id FROM suporte_chamados WHERE id = ?')
      .get(r.json.chamado.id);
    assert.strictEqual(linha.tenant_id, EMPRESA_A, 'o corpo da requisição escolheu o tenant');
  });
  await t('D6 tenant_id na QUERY também não', async () => {
    como(CHEFE, T_A);
    const r = await pedir('GET', '/api/suporte/chamados?tenant_id=' + EMPRESA_B + '&tenantId=' + EMPRESA_B);
    assert.strictEqual(r.status, 200);
    const txt = JSON.stringify(r.json);
    assert.ok(!txt.includes('Segredo da B'), 'a query trouxe chamado da outra empresa');
  });
  await t('D7 A não responde no chamado de B', async () => {
    como(CHEFE, T_A);
    const r = await pedir('POST', '/api/suporte/chamados/' + chamadoDora + '/mensagens',
      { corpo: 'invasão' });
    assert.strictEqual(r.status, 404);
    const n = controlDb.prepare('SELECT COUNT(*) n FROM suporte_mensagens WHERE chamado_id = ?')
      .get(chamadoDora).n;
    assert.strictEqual(n, 0, 'a mensagem foi gravada no chamado alheio');
  });
  await t('D8 A não reabre o chamado de B', async () => {
    repo.admin.mudarStatus(controlDb, chamadoDora, 'resolvido');
    como(CHEFE, T_A);
    const r = await pedir('POST', '/api/suporte/chamados/' + chamadoDora + '/reabrir', { corpo: 'x' });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(controlDb.prepare('SELECT status FROM suporte_chamados WHERE id = ?')
      .get(chamadoDora).status, 'resolvido', 'o chamado alheio foi reaberto');
  });
  await t('D9 a lista de A nunca traz a B', async () => {
    como(CHEFE, T_A);
    const r = await pedir('GET', '/api/suporte/chamados');
    const numerosB = controlDb.prepare('SELECT numero FROM suporte_chamados WHERE tenant_id = ?')
      .all(EMPRESA_B).map((x) => x.numero);
    const txt = JSON.stringify(r.json);
    for (const n of numerosB) assert.ok(!txt.includes(n), 'o número ' + n + ' da empresa B apareceu');
  });

  // ══ E. nota interna ═══════════════════════════════════════════════════════
  console.log('\n== E. nota interna ==');
  await t('E1 nota interna nunca aparece na API do cliente', async () => {
    repo.admin.responder(controlDb, chamadoAna, { corpo: 'PUBLICA: estamos vendo', adminId });
    repo.admin.responder(controlDb, chamadoAna, { corpo: 'SEGREDO_INTERNO_123', adminId, interna: true });
    como(ANA, T_A);
    const r = await pedir('GET', '/api/suporte/chamados/' + chamadoAna);
    const txt = JSON.stringify(r.json);
    assert.ok(!txt.includes('SEGREDO_INTERNO_123'), 'a nota interna vazou pela API');
    assert.ok(txt.includes('PUBLICA'), 'a mensagem pública sumiu junto');
  });
  await t('E2 o cliente não cria nota interna nem mandando o campo', async () => {
    como(ANA, T_A);
    await pedir('POST', '/api/suporte/chamados/' + chamadoAna + '/mensagens',
      { corpo: 'tentando ser interna', interna: true, interna_flag: 1 });
    const linha = controlDb.prepare(
      "SELECT interna FROM suporte_mensagens WHERE corpo = 'tentando ser interna'").get();
    assert.ok(linha, 'a mensagem não foi gravada');
    assert.strictEqual(linha.interna, 0, 'o cliente criou uma nota interna');
  });

  // ══ F. responder e reabrir ════════════════════════════════════════════════
  console.log('\n== F. responder e reabrir ==');
  await t('F1 o cliente responde o próprio chamado', async () => {
    como(ANA, T_A);
    const r = await pedir('POST', '/api/suporte/chamados/' + chamadoAna + '/mensagens',
      { corpo: 'obrigada, vou testar' });
    assert.strictEqual(r.status, 201);
  });
  await t('F2 resposta vazia é 400', async () => {
    como(ANA, T_A);
    assert.strictEqual((await pedir('POST', '/api/suporte/chamados/' + chamadoAna + '/mensagens',
      { corpo: '   ' })).status, 400);
  });
  await t('F3 chamado resolvido pode ser reaberto', async () => {
    repo.admin.mudarStatus(controlDb, chamadoAna, 'resolvido');
    como(ANA, T_A);
    const r = await pedir('POST', '/api/suporte/chamados/' + chamadoAna + '/reabrir',
      { corpo: 'o problema voltou' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(controlDb.prepare('SELECT status FROM suporte_chamados WHERE id = ?')
      .get(chamadoAna).status, 'em_atendimento');
  });
  await t('F4 chamado encerrado não aceita resposta nem reabertura', async () => {
    repo.admin.mudarStatus(controlDb, chamadoAna, 'encerrado');
    como(ANA, T_A);
    assert.strictEqual((await pedir('POST', '/api/suporte/chamados/' + chamadoAna + '/mensagens',
      { corpo: 'mais uma' })).status, 400);
    assert.strictEqual((await pedir('POST', '/api/suporte/chamados/' + chamadoAna + '/reabrir',
      { corpo: 'quero de volta' })).status, 400);
    repo.admin.mudarStatus(controlDb, chamadoAna, 'em_atendimento');
  });

  // ══ G. XSS ════════════════════════════════════════════════════════════════
  console.log('\n== G. XSS ==');
  await t('G1 script no assunto volta como texto, não como marcação', async () => {
    como(ANA, T_A);
    const payload = '<script>alert("xss")</scr' + 'ipt>';
    const r = await pedir('POST', '/api/suporte/chamados',
      { categoriaId: catDe('duvida').id, assunto: payload, descricao: 'img <img src=x onerror=alert(1)>' });
    assert.strictEqual(r.status, 201);
    /* O servidor guarda o que foi digitado, sem reescrever: escapar no banco
       produz texto escapado duas vezes na tela. A defesa é a renderização
       (textContent nas telas), e o que se prova aqui é que o conteúdo viaja
       como DADO no JSON — não há marcação injetada na resposta. */
    const vista = await pedir('GET', '/api/suporte/chamados/' + r.json.chamado.id);
    assert.strictEqual(vista.json.chamado.assunto, payload, 'o servidor alterou o conteúdo');
    const bruto = JSON.stringify(vista.json);
    assert.ok(bruto.includes('\\u003c') || bruto.includes('<script>'),
      'o payload precisa estar no JSON como string');
    assert.strictEqual(typeof vista.json.chamado.assunto, 'string');
  });
  await t('G2 as telas usam textContent no conteúdo do usuário', () => {
    const conv = fs.readFileSync(path.join(RAIZ, 'public/suporte/chamado.html'), 'utf8');
    assert.ok(/balao\.textContent\s*=\s*m\.corpo/.test(conv),
      'o corpo da mensagem precisa entrar por textContent');
    assert.ok(!/innerHTML\s*=\s*[^;]*m\.corpo/.test(conv),
      'o corpo da mensagem está indo para innerHTML');
    const lista = fs.readFileSync(path.join(RAIZ, 'public/suporte/chamados.html'), 'utf8');
    assert.ok(/function esc\(/.test(lista), 'a lista precisa escapar o que injeta por template');
    assert.ok(/esc\(c\.assunto\)/.test(lista), 'o assunto entrou na lista sem escapar');
  });

  // ══ H. comum x administrador da empresa ═══════════════════════════════════
  console.log('\n== H. comum x administrador da empresa ==');
  let chamadoBruno = null;
  await t('H1 Bruno abre um chamado dele', async () => {
    como(BRUNO, T_A);
    const r = await pedir('POST', '/api/suporte/chamados',
      { categoriaId: catDe('duvida').id, assunto: 'Chamado do Bruno', descricao: 'x' });
    assert.strictEqual(r.status, 201);
    chamadoBruno = r.json.chamado.id;
  });
  await t('H2 Ana (comum) NÃO vê o chamado do colega', async () => {
    como(ANA, T_A);
    const r = await pedir('GET', '/api/suporte/chamados/' + chamadoBruno);
    assert.strictEqual(r.status, 404, 'usuário comum leu o chamado de um colega');
    const lista = await pedir('GET', '/api/suporte/chamados');
    assert.strictEqual(lista.json.escopo, 'proprios');
    assert.ok(!JSON.stringify(lista.json).includes('Chamado do Bruno'));
  });
  await t('H3 o administrador da empresa vê o da empresa toda', async () => {
    como(CHEFE, T_A);
    const lista = await pedir('GET', '/api/suporte/chamados');
    assert.strictEqual(lista.json.escopo, 'empresa');
    assert.ok(JSON.stringify(lista.json).includes('Chamado do Bruno'),
      'o administrador não enxergou o chamado do funcionário');
    assert.strictEqual((await pedir('GET', '/api/suporte/chamados/' + chamadoBruno)).status, 200);
  });
  await t('H4 o administrador de A continua sem ver a empresa B', async () => {
    como(CHEFE, T_A);
    assert.strictEqual((await pedir('GET', '/api/suporte/chamados/' + chamadoDora)).status, 404,
      'ser admin da empresa A deu acesso à empresa B');
    const lista = await pedir('GET', '/api/suporte/chamados');
    assert.ok(!JSON.stringify(lista.json).includes('Segredo da B'));
  });
  await t('H5 usuário comum não responde no chamado do colega', async () => {
    como(ANA, T_A);
    const r = await pedir('POST', '/api/suporte/chamados/' + chamadoBruno + '/mensagens',
      { corpo: 'intrometida' });
    assert.strictEqual(r.status, 404);
  });

  // ══ I. sem perfil não herda a empresa ═════════════════════════════════════
  console.log('\n== I. sem perfil não herda a empresa ==');
  await t('I1 o usuário sem perfil é irrestrito no RBAC do ERP', () => {
    /* Confirma a premissa: pelo gate genérico o Zeca passaria por tudo. É
       justamente por isso que a Central precisa da própria regra. */
    const { acessoDoUsuario } = require(path.join(RAIZ, 'perfis-acesso'));
    const a = acessoDoUsuario(tenantDb, ZECA);
    assert.strictEqual(a.irrestrito, true, 'a premissa mudou: sem-perfil deixou de ser irrestrito');
    assert.strictEqual(a.motivo, 'sem-perfil');
  });
  await t('I2 mas na Central ele vê SÓ os próprios chamados', async () => {
    como(ZECA, T_A);
    const r = await pedir('GET', '/api/suporte/chamados');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.escopo, 'proprios',
      'sem-perfil recebeu escopo de empresa');
    assert.ok(!JSON.stringify(r.json).includes('Chamado do Bruno'),
      'sem-perfil enxergou o chamado de um colega na lista');
  });
  await t('I3 sem perfil abrindo chamado de colega recebe 404', async () => {
    como(ZECA, T_A);
    assert.strictEqual((await pedir('GET', '/api/suporte/chamados/' + chamadoBruno)).status, 404,
      'sem-perfil leu o chamado de um colega');
  });
  await t('I4 sem perfil não responde no chamado do colega', async () => {
    como(ZECA, T_A);
    const r = await pedir('POST', '/api/suporte/chamados/' + chamadoBruno + '/mensagens',
      { corpo: 'intrometido' });
    assert.strictEqual(r.status, 404);
  });
  await t('I5 sem perfil vê os chamados que ELE abriu', async () => {
    como(ZECA, T_A);
    const criado = await pedir('POST', '/api/suporte/chamados',
      { categoriaId: catDe('duvida').id, assunto: 'Chamado do Zeca', descricao: 'x' });
    assert.strictEqual(criado.status, 201);
    const lista = await pedir('GET', '/api/suporte/chamados');
    assert.ok(JSON.stringify(lista.json).includes('Chamado do Zeca'),
      'o usuário perdeu acesso ao próprio chamado');
    assert.strictEqual((await pedir('GET', '/api/suporte/chamados/' + criado.json.chamado.id)).status, 200);
  });
  await t('I6 sem perfil continua sem ver a outra empresa', async () => {
    como(ZECA, T_A);
    assert.strictEqual((await pedir('GET', '/api/suporte/chamados/' + chamadoDora)).status, 404);
  });
  await t('I7 a regra da Central NÃO mexe no RBAC das outras áreas', () => {
    /* `perfis-acesso.js` não foi tocado: a diferença vive em `vePorEmpresa`,
       dentro do suporte-routes. Se alguém mudar o gate genérico para fechar o
       sem-perfil, este caso avisa — porque aí a mudança passou a ser global. */
    const fonte = fs.readFileSync(path.join(RAIZ, 'perfis-acesso.js'), 'utf8');
    assert.ok(/if \(!row \|\| !row\.ativo\) return \{ irrestrito: true, motivo: 'sem-perfil' \};/.test(fonte),
      'o fail-open genérico do ERP foi alterado — isso afeta TODAS as áreas, não só o suporte');
    const rotas = fs.readFileSync(path.join(RAIZ, 'suporte-routes.js'), 'utf8');
    assert.ok(/motivo === 'admin'/.test(rotas),
      'a Central deixou de exigir administrador real');
  });

  srv.close();
  controlDb.close();
  tenantDb.close();
  console.log(`\n${fail === 0 ? 'TODOS OS CASOS PASSARAM' : fail + ' CASO(S) REPROVARAM'}  (${ok} ok, ${fail} falhas)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERRO:', e.stack || e.message); process.exit(1); });
