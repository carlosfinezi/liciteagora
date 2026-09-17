/**
 * Gestão de categorias de produto (Fase 44).
 *
 * Categoria continua sendo TEXT em `produtos`; `produto_lookup` (tipo
 * 'categoria') é o catálogo de valores. Não há FK — o vínculo é o texto.
 *
 * ── O que este teste realmente protege ──────────────────────────────────────
 *
 * Renomear. É a única operação aqui que toca dado de negócio em mais de um
 * lugar: `produtos.categoria` E `comissoes_regras.categoriaProduto`, que
 * `comissoes-calculo.js:86` compara por igualdade exata. Um rename que atualize
 * só metade não dá erro nenhum — a regra de comissão simplesmente deixa de
 * casar, e o defeito aparece no fechamento do mês, como comissão errada.
 *
 * Por isso os blocos G, H e I existem, e por isso o I derruba a transação de
 * propósito para exigir que NADA tenha sido gravado.
 *
 * Banco descartável, montado a partir do schema real de um tenant lido em
 * somente-leitura. Nenhum dado de produção é tocado — em especial as
 * categorias `Outros`/`OUTROS` do produtosbomgosto, que devem permanecer como
 * estão até a operação de unificação, que é outra fase.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const TMP = '/tmp/test-categorias';
fs.mkdirSync(TMP, { recursive: true });

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------------------------------------------------------------- harness
const ORIGEM = path.join(RAIZ, 'data/tenants/1bit/pncp.db');
const SCHEMA = path.join(TMP, 'schema.sql');
if (!fs.existsSync(SCHEMA)) {
  if (!fs.existsSync(ORIGEM)) { console.error('tenant 1bit ausente'); process.exit(2); }
  fs.writeFileSync(SCHEMA, execFileSync('sqlite3', [`file:${ORIGEM}?mode=ro`, '.schema']).toString());
}

/**
 * Só as tabelas que esta fase toca — mas com o DDL REAL do tenant.
 *
 * O schema inteiro tem 799 statements e leva 11 s para montar; com um banco por
 * teste isso dava 3 minutos e o teste não terminava. Recortar preserva o que
 * importa (as colunas e restrições são as de produção, não uma imitação) e
 * monta em milissegundos.
 */
// `pessoas` e `users` entram porque `comissoes_regras` as referencia; sem elas
// o INSERT falha em 'no such table'.
const TABELAS = ['produtos', 'produto_lookup', 'comissoes_regras', 'pessoas', 'users'];
const DDL = (() => {
  const bruto = fs.readFileSync(SCHEMA, 'utf8');
  const fora = [];
  for (const st of bruto.split(/;\s*\n/)) {
    const m = /CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)[^(]*?["'`]?(\w+)["'`]?\s*(?:\(|ON\s+["'`]?(\w+))/i.exec(st);
    if (!m) continue;
    const alvo = m[1].toUpperCase() === 'TABLE' ? m[2] : m[3];
    if (TABELAS.includes(alvo)) fora.push(st);
  }
  return fora.join(';\n') + ';';
})();

function novoBanco(nome) {
  const arq = path.join(TMP, nome + '.db');
  try { fs.unlinkSync(arq); } catch (_) {}
  const db = new Database(arq);
  db.exec(DDL);
  return db;
}

function montar(nome) {
  const db = novoBanco(nome);
  const app = express();
  require('../produto-lookup-routes').registrarRotasProdutoLookup(app, db);

  const achar = (p, m) => {
    const l = ((app.router || app._router).stack || [])
      .find((x) => x.route && x.route.path === p && x.route.methods[m]);
    if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
    return l.route.stack.at(-1).handle;
  };
  const chamar = (p, m, o = {}) => {
    let corpo = null, st = 200;
    const res = {
      json: (x) => { corpo = x; return res; },
      status: (c) => { st = c; return res; },
      setHeader: () => res, send: (x) => { corpo = x; return res; },
    };
    achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {},
                  session: {}, headers: {} }, res);
    return { corpo, st };
  };
  return { db, chamar };
}

/** Produto e categoria de teste. */
function seed(db, { categoria, sku, ativo = 1 }) {
  db.prepare(`INSERT INTO produtos (sku, descricao, categoria, ativo, precoVenda)
              VALUES (?, ?, ?, ?, 10)`).run(sku, 'PRODUTO ' + sku, categoria, ativo);
}
const lookup = (db, valor) => db.prepare(
  "SELECT * FROM produto_lookup WHERE tipo='categoria' AND valor = ?").get(valor);
const catDoProduto = (db, sku) => db.prepare('SELECT categoria FROM produtos WHERE sku = ?').get(sku).categoria;

// ============================================================================
// A–E. Listar e criar
// ============================================================================

t('A. lista categorias, com contagem e status', () => {
  const { db, chamar } = montar('a');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'TEMPEROS' } });
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'CHÁS' } });
  seed(db, { categoria: 'TEMPEROS', sku: '1' });
  seed(db, { categoria: 'TEMPEROS', sku: '2', ativo: 0 });

  const r = chamar('/api/produto-lookup/:tipo', 'get',
    { params: { tipo: 'categoria' }, query: { todos: '1', contagem: '1' } });
  assert(r.corpo.success, 'listagem falhou');
  const temp = r.corpo.itens.find((i) => i.valor === 'TEMPEROS');
  // Contagem TOTAL: é ela que importa antes de renomear ou excluir.
  assert(temp.produtos === 2, `contagem total deveria ser 2, veio ${temp.produtos}`);
  assert(temp.produtosAtivos === 1, `ativos deveria ser 1, veio ${temp.produtosAtivos}`);
  assert(r.corpo.itens.find((i) => i.valor === 'CHÁS').produtos === 0, 'categoria sem produto deveria contar 0');
  // Ordem alfabética, sem coluna `ordem` nesta fase.
  assert(r.corpo.itens[0].valor === 'CHÁS', 'não veio em ordem alfabética');
});

t('A2. a listagem SEM parametros nao mudou (o datalist depende dela)', () => {
  const { chamar } = montar('a2');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'X' } });
  chamar('/api/produto-lookup/:tipo/:valor', 'delete', { params: { tipo: 'categoria', valor: 'X' } });
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'Y' } });
  const r = chamar('/api/produto-lookup/:tipo', 'get', { params: { tipo: 'categoria' } });
  assert(r.corpo.itens.length === 1 && r.corpo.itens[0].valor === 'Y',
    'a resposta padrão deixou de trazer só os ativos — seis telas dependem dela');
  assert(!('ativo' in r.corpo.itens[0]), 'a resposta padrão mudou de forma');
});

t('B. cria categoria', () => {
  const { db, chamar } = montar('b');
  const r = chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'CONFEITOS' } });
  assert(r.corpo.success, 'não criou');
  assert(lookup(db, 'CONFEITOS'), 'não gravou no lookup');
});

t('C. recusa vazio e so espacos', () => {
  const { chamar } = montar('c');
  for (const v of ['', '   ', '\t', null, undefined]) {
    const r = chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: v } });
    assert(r.st === 400, `aceitou ${JSON.stringify(v)} como nome`);
    assert(!/undefined|null/.test(r.corpo.error), 'mensagem técnica: ' + r.corpo.error);
  }
});

t('D. faz trim nas bordas', () => {
  const { db, chamar } = montar('d');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: '  TEMPEROS  ' } });
  assert(lookup(db, 'TEMPEROS'), 'não gravou com trim');
  assert(!lookup(db, '  TEMPEROS  '), 'gravou com espaços nas bordas');
});

t('E. recusa duplicata ignorando maiusculas e espacos', () => {
  const { db, chamar } = montar('e');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'TEMPEROS' } });
  for (const v of ['Temperos', 'temperos', '  TEMPEROS  ', 'TeMpErOs']) {
    const r = chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: v } });
    // `  TEMPEROS  ` vira `TEMPEROS` no trim: é o mesmo texto, então é
    // reativação, não duplicata. As demais diferem no caso e são recusadas.
    if (v.trim() === 'TEMPEROS') { assert(r.corpo.success, 'o mesmo texto deveria ser aceito (reativação)'); continue; }
    assert(r.st === 409, `aceitou "${v}" ao lado de TEMPEROS`);
    assert(r.corpo.existente === 'TEMPEROS', 'não disse qual já existe');
  }
  const n = db.prepare("SELECT COUNT(*) n FROM produto_lookup WHERE tipo='categoria'").get().n;
  assert(n === 1, `criou ${n} registros — deveria ser 1`);
});

// ============================================================================
// F–I. Renomear — a operação que precisa alcançar tudo
// ============================================================================

t('F. renomeia categoria sem produtos', () => {
  const { db, chamar } = montar('f');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'ANTIGA' } });
  const r = chamar('/api/produto-lookup/:tipo/:valor', 'put',
    { params: { tipo: 'categoria', valor: 'ANTIGA' }, body: { novo: 'NOVA' } });
  assert(r.corpo.success, 'rename falhou: ' + JSON.stringify(r.corpo));
  assert(lookup(db, 'NOVA') && !lookup(db, 'ANTIGA'), 'o lookup não acompanhou');
});

t('G. renomeia categoria COM produtos (cascata em produtos)', () => {
  const { db, chamar } = montar('g');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'TEMPEROS' } });
  seed(db, { categoria: 'TEMPEROS', sku: '1' });
  seed(db, { categoria: 'TEMPEROS', sku: '2', ativo: 0 });
  seed(db, { categoria: 'OUTRA', sku: '3' });

  const r = chamar('/api/produto-lookup/:tipo/:valor', 'put',
    { params: { tipo: 'categoria', valor: 'TEMPEROS' }, body: { novo: 'CONDIMENTOS' } });
  assert(r.corpo.success, 'rename falhou');
  assert(r.corpo.produtos === 2, `disse ter tocado ${r.corpo.produtos} produtos, esperado 2`);
  assert(catDoProduto(db, '1') === 'CONDIMENTOS', 'produto ativo não acompanhou');
  // Produto inativo também: ele guarda o texto e voltaria com o nome velho.
  assert(catDoProduto(db, '2') === 'CONDIMENTOS', 'produto INATIVO não acompanhou');
  assert(catDoProduto(db, '3') === 'OUTRA', 'renomeou produto de outra categoria');
  assert(lookup(db, 'CONDIMENTOS') && !lookup(db, 'TEMPEROS'), 'o lookup não acompanhou');
});

t('H. renomear atualiza as REGRAS DE COMISSAO', () => {
  // `comissoes-calculo.js:86` compara `r.categoriaProduto !== produto.categoria`
  // por igualdade exata. Esquecer esta tabela deixa a regra sem casar — sem
  // erro, sem log, e a comissão sai errada no fim do mês.
  const { db, chamar } = montar('h');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'TEMPEROS' } });
  seed(db, { categoria: 'TEMPEROS', sku: '1' });
  db.prepare(`INSERT INTO comissoes_regras (nome, categoriaProduto, tipo, valor, ativo)
              VALUES ('Regra temperos', 'TEMPEROS', 'percentual', 5, 1)`).run();
  db.prepare(`INSERT INTO comissoes_regras (nome, categoriaProduto, tipo, valor, ativo)
              VALUES ('Regra outra', 'OUTRA', 'percentual', 3, 1)`).run();

  chamar('/api/produto-lookup/:tipo/:valor', 'put',
    { params: { tipo: 'categoria', valor: 'TEMPEROS' }, body: { novo: 'CONDIMENTOS' } });

  const regra = db.prepare("SELECT categoriaProduto FROM comissoes_regras WHERE nome='Regra temperos'").get();
  assert(regra.categoriaProduto === 'CONDIMENTOS',
    `a regra de comissão ficou com "${regra.categoriaProduto}" — deixaria de casar com o produto`);
  const outra = db.prepare("SELECT categoriaProduto FROM comissoes_regras WHERE nome='Regra outra'").get();
  assert(outra.categoriaProduto === 'OUTRA', 'mexeu na regra de outra categoria');

  // A prova que interessa: produto e regra continuam apontando um para o outro.
  assert(catDoProduto(db, '1') === regra.categoriaProduto,
    'produto e regra de comissão ficaram com textos diferentes');
});

t('I. se uma etapa falhar, NADA e gravado (rollback total)', () => {
  const { db, chamar } = montar('i');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'TEMPEROS' } });
  seed(db, { categoria: 'TEMPEROS', sku: '1' });
  db.prepare(`INSERT INTO comissoes_regras (nome, categoriaProduto, tipo, valor, ativo)
              VALUES ('R', 'TEMPEROS', 'percentual', 5, 1)`).run();

  // Sabota o ÚLTIMO passo da transação: um gatilho que recusa a escrita em
  // comissoes_regras. Se a transação não for atômica, produtos e lookup já
  // teriam sido gravados quando isto disparar.
  db.exec(`CREATE TRIGGER trava BEFORE UPDATE ON comissoes_regras
           BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;`);

  const r = chamar('/api/produto-lookup/:tipo/:valor', 'put',
    { params: { tipo: 'categoria', valor: 'TEMPEROS' }, body: { novo: 'CONDIMENTOS' } });
  assert(r.st === 500, `a falha foi engolida (status ${r.st})`);

  assert(lookup(db, 'TEMPEROS'), 'o lookup ficou com o nome novo apesar da falha');
  assert(!lookup(db, 'CONDIMENTOS'), 'gravou o nome novo apesar da falha');
  assert(catDoProduto(db, '1') === 'TEMPEROS',
    'o produto ficou com o nome novo e a regra com o antigo — é exatamente a metade que não pode existir');
  db.exec('DROP TRIGGER trava');
});

t('I2. renomear para nome que ja existe (outra caixa) e recusado', () => {
  const { chamar } = montar('i2');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'TEMPEROS' } });
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'CHÁS' } });
  const r = chamar('/api/produto-lookup/:tipo/:valor', 'put',
    { params: { tipo: 'categoria', valor: 'CHÁS' }, body: { novo: 'temperos' } });
  assert(r.st === 409, 'aceitou renomear para uma duplicata de caixa');
});

t('I3. renomear so a CAIXA da propria categoria e permitido', () => {
  // "outros" → "OUTROS" não é duplicata: é o mesmo registro se corrigindo.
  const { db, chamar } = montar('i3');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'outros' } });
  seed(db, { categoria: 'outros', sku: '1' });
  const r = chamar('/api/produto-lookup/:tipo/:valor', 'put',
    { params: { tipo: 'categoria', valor: 'outros' }, body: { novo: 'OUTROS' } });
  assert(r.corpo.success, 'recusou corrigir a caixa do próprio nome: ' + JSON.stringify(r.corpo));
  assert(catDoProduto(db, '1') === 'OUTROS', 'o produto não acompanhou');
});

// ============================================================================
// J. Ótica
// ============================================================================

t('J. armacao e lente nao podem ser renomeadas nem excluidas', () => {
  const { db, chamar } = montar('j');
  for (const reservada of ['armacao', 'lente']) {
    db.prepare("INSERT INTO produto_lookup (tipo, valor) VALUES ('categoria', ?)").run(reservada);

    const ren = chamar('/api/produto-lookup/:tipo/:valor', 'put',
      { params: { tipo: 'categoria', valor: reservada }, body: { novo: 'QUALQUER' } });
    assert(ren.st === 423, `"${reservada}" pôde ser renomeada (status ${ren.st})`);
    assert(/Ótica/i.test(ren.corpo.error), 'não explica o motivo: ' + ren.corpo.error);
    assert(lookup(db, reservada), 'renomeou mesmo devolvendo erro');

    const exc = chamar('/api/produto-lookup/categoria/:valor/excluir', 'post',
      { params: { valor: reservada }, body: {} });
    assert(exc.st === 423, `"${reservada}" pôde ser excluída`);
    assert(lookup(db, reservada), 'excluiu mesmo devolvendo erro');
  }
  // E não se pode plantar uma reservada renomeando outra categoria para ela.
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'NORMAL' } });
  const p = chamar('/api/produto-lookup/:tipo/:valor', 'put',
    { params: { tipo: 'categoria', valor: 'NORMAL' }, body: { novo: 'lente' } });
  assert(p.st === 423, 'deixou renomear uma categoria comum PARA um valor reservado da Ótica');
});

// ============================================================================
// K–M. Ativar / desativar
// ============================================================================

t('K. desativa e reativa', () => {
  const { db, chamar } = montar('k');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'SAZONAL' } });
  chamar('/api/produto-lookup/:tipo/:valor', 'delete', { params: { tipo: 'categoria', valor: 'SAZONAL' } });
  assert(lookup(db, 'SAZONAL').ativo === 0, 'não inativou');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'SAZONAL' } });
  assert(lookup(db, 'SAZONAL').ativo === 1, 'não reativou');
});

t('L. categoria inativa sai das sugestoes do cadastro de produto', () => {
  const { chamar } = montar('l');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'ATIVA' } });
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'INATIVA' } });
  chamar('/api/produto-lookup/:tipo/:valor', 'delete', { params: { tipo: 'categoria', valor: 'INATIVA' } });

  // O datalist do cadastro chama a rota sem parâmetros.
  const sug = chamar('/api/produto-lookup/:tipo', 'get', { params: { tipo: 'categoria' } });
  const nomes = sug.corpo.itens.map((i) => i.valor);
  assert(nomes.includes('ATIVA'), 'a ativa sumiu das sugestões');
  assert(!nomes.includes('INATIVA'), 'a inativa continua sendo sugerida em novos cadastros');

  // Mas a tela de gestão precisa vê-la para poder reativar.
  const ger = chamar('/api/produto-lookup/:tipo', 'get', { params: { tipo: 'categoria' }, query: { todos: '1' } });
  assert(ger.corpo.itens.some((i) => i.valor === 'INATIVA'), 'a inativa sumiu também da tela de gestão');
});

t('M. inativar NAO mexe nos produtos que ja a usam', () => {
  const { db, chamar } = montar('m');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'SAZONAL' } });
  seed(db, { categoria: 'SAZONAL', sku: '1' });
  chamar('/api/produto-lookup/:tipo/:valor', 'delete', { params: { tipo: 'categoria', valor: 'SAZONAL' } });
  assert(catDoProduto(db, '1') === 'SAZONAL',
    'inativar apagou a categoria do produto — histórico e relatórios perderiam a classificação');
});

// ============================================================================
// N–Q. Exclusão
// ============================================================================

t('N. exclui categoria sem uso', () => {
  const { db, chamar } = montar('n');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'VAZIA' } });
  const r = chamar('/api/produto-lookup/categoria/:valor/excluir', 'post', { params: { valor: 'VAZIA' }, body: {} });
  assert(r.corpo.success, 'não excluiu: ' + JSON.stringify(r.corpo));
  assert(!lookup(db, 'VAZIA'), 'continua no lookup');
});

t('O. NAO exclui em silencio categoria com produtos', () => {
  const { db, chamar } = montar('o');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'EM_USO' } });
  seed(db, { categoria: 'EM_USO', sku: '1' });
  seed(db, { categoria: 'EM_USO', sku: '2' });

  const r = chamar('/api/produto-lookup/categoria/:valor/excluir', 'post', { params: { valor: 'EM_USO' }, body: {} });
  assert(r.st === 409, `excluiu sem pedir decisão (status ${r.st})`);
  assert(r.corpo.precisaDecisao === true, 'não sinaliza que precisa de decisão');
  assert(r.corpo.produtos === 2, `informou ${r.corpo.produtos} produtos, esperado 2`);
  assert(lookup(db, 'EM_USO'), 'excluiu mesmo devolvendo 409');
  assert(catDoProduto(db, '1') === 'EM_USO', 'mexeu no produto sem autorização');
});

t('P. move os produtos para outra categoria', () => {
  const { db, chamar } = montar('p');
  for (const v of ['ORIGEM', 'DESTINO']) {
    chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: v } });
  }
  seed(db, { categoria: 'ORIGEM', sku: '1' });
  seed(db, { categoria: 'ORIGEM', sku: '2', ativo: 0 });
  db.prepare(`INSERT INTO comissoes_regras (nome, categoriaProduto, tipo, valor, ativo)
              VALUES ('R', 'ORIGEM', 'percentual', 5, 1)`).run();

  const r = chamar('/api/produto-lookup/categoria/:valor/excluir', 'post',
    { params: { valor: 'ORIGEM' }, body: { acao: 'mover', destino: 'DESTINO' } });
  assert(r.corpo.success, 'não moveu: ' + JSON.stringify(r.corpo));
  assert(catDoProduto(db, '1') === 'DESTINO' && catDoProduto(db, '2') === 'DESTINO', 'produtos não migraram');
  assert(!lookup(db, 'ORIGEM'), 'a categoria de origem continua na lista');
  const regra = db.prepare("SELECT categoriaProduto FROM comissoes_regras WHERE nome='R'").get();
  assert(regra.categoriaProduto === 'DESTINO', 'a regra de comissão ficou apontando para categoria inexistente');
});

t('P2. nao move para ela mesma nem para destino inexistente', () => {
  const { db, chamar } = montar('p2');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'A' } });
  seed(db, { categoria: 'A', sku: '1' });
  const mesma = chamar('/api/produto-lookup/categoria/:valor/excluir', 'post',
    { params: { valor: 'A' }, body: { acao: 'mover', destino: 'A' } });
  assert(mesma.st === 400, 'deixou mover a categoria para ela mesma');
  const fantasma = chamar('/api/produto-lookup/categoria/:valor/excluir', 'post',
    { params: { valor: 'A' }, body: { acao: 'mover', destino: 'NAO_EXISTE' } });
  assert(fantasma.st === 400, 'deixou mover para uma categoria que não existe');
  assert(lookup(db, 'A'), 'excluiu apesar do erro');
});

t('Q. deixa os produtos sem categoria', () => {
  const { db, chamar } = montar('q');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'SUMIR' } });
  seed(db, { categoria: 'SUMIR', sku: '1' });
  const r = chamar('/api/produto-lookup/categoria/:valor/excluir', 'post',
    { params: { valor: 'SUMIR' }, body: { acao: 'limpar' } });
  assert(r.corpo.success, 'não excluiu');
  assert(catDoProduto(db, '1') === null, 'o produto não ficou sem categoria');
  // Sem categoria = NULL. Nada de gravar a string "Sem categoria", que a Venda
  // rápida passaria a mostrar como categoria de verdade.
  assert(!lookup(db, 'Sem categoria'), 'criou uma categoria chamada "Sem categoria"');
});

// ============================================================================
// R–T. Integrações
// ============================================================================

t('R. o botao "+" do cadastro de produto usa a MESMA validacao', () => {
  // Ele chama o mesmo POST — a guarda de duplicata é do servidor, não da tela.
  const { db, chamar } = montar('r');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'TEMPEROS' } });
  const r = chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'Temperos' } });
  assert(r.st === 409, 'o "+" do cadastro poderia criar duplicata de caixa');
  const n = db.prepare("SELECT COUNT(*) n FROM produto_lookup WHERE tipo='categoria'").get().n;
  assert(n === 1, `ficaram ${n} registros`);

  const tela = fs.readFileSync(path.join(RAIZ, 'public/catalogo/produto.html'), 'utf8');
  assert(/cadastrarLookup\('categoria'\)/.test(tela), 'o botão "+" sumiu do cadastro');
  assert(/\/api\/produto-lookup\/'\+tipo/.test(tela) || /produto-lookup/.test(tela),
    'o "+" deixou de usar o endpoint central');
});

t('S. renomear reflete na Venda rapida (ela deriva dos produtos)', () => {
  const { db, chamar } = montar('s');
  chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'TEMPEROS' } });
  seed(db, { categoria: 'TEMPEROS', sku: '1' });
  seed(db, { categoria: 'TEMPEROS', sku: '2' });
  chamar('/api/produto-lookup/:tipo/:valor', 'put',
    { params: { tipo: 'categoria', valor: 'TEMPEROS' }, body: { novo: 'CONDIMENTOS' } });

  // A Venda rápida monta a barra a partir de `produtos.categoria` (catDe), não
  // do lookup. Se o rename não tivesse chegado aos produtos, ela continuaria
  // mostrando o nome velho.
  const cats = db.prepare(`SELECT DISTINCT categoria FROM produtos
                           WHERE categoria IS NOT NULL AND TRIM(categoria) <> ''`).all().map((r) => r.categoria);
  assert(cats.includes('CONDIMENTOS'), 'a Venda rápida continuaria sem o nome novo');
  assert(!cats.includes('TEMPEROS'), 'a Venda rápida continuaria mostrando o nome antigo');

  const pdv = fs.readFileSync(path.join(RAIZ, 'public/comercial/pedidos-pdv.html'), 'utf8');
  assert(/function catDe/.test(pdv) && /GROUP|mapa\.set/.test(pdv),
    'a Venda rápida mudou de fonte de categorias — esta rodada não devia tocá-la');
});

t('T. isolamento: operacao num tenant nao alcanca o outro', () => {
  const a = montar('t_a');
  const b = montar('t_b');
  for (const x of [a, b]) {
    x.chamar('/api/produto-lookup/:tipo', 'post', { params: { tipo: 'categoria' }, body: { valor: 'TEMPEROS' } });
    seed(x.db, { categoria: 'TEMPEROS', sku: '1' });
  }
  a.chamar('/api/produto-lookup/:tipo/:valor', 'put',
    { params: { tipo: 'categoria', valor: 'TEMPEROS' }, body: { novo: 'RENOMEADA_EM_A' } });

  assert(lookup(a.db, 'RENOMEADA_EM_A'), 'o rename não valeu no próprio tenant');
  assert(lookup(b.db, 'TEMPEROS'), 'o tenant B perdeu a categoria');
  assert(!lookup(b.db, 'RENOMEADA_EM_A'), 'o rename atravessou para o tenant B');
  assert(catDoProduto(b.db, '1') === 'TEMPEROS', 'o produto do tenant B foi alterado');
});

t('T2. nenhum tenant fixo no codigo novo', () => {
  const rotas = fs.readFileSync(path.join(RAIZ, 'produto-lookup-routes.js'), 'utf8');
  const tela = fs.readFileSync(path.join(RAIZ, 'public/catalogo/categorias.html'), 'utf8');
  for (const fonte of [rotas, tela]) {
    const semCom = fonte.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const proibido of ['produtosbomgosto', '1bit', 'tenantId', 'organizationId']) {
      assert(!semCom.includes(proibido), `código novo carrega "${proibido}"`);
    }
  }
});

t('T3. a tela esta no menu e no mapa de RBAC', () => {
  const menu = fs.readFileSync(path.join(RAIZ, 'public/js/menu-config.js'), 'utf8');
  assert(/page: 'cadastro-categorias'[^}]*catalogo\/categorias\.html/.test(menu),
    'a página não está no menu');
  // Logo depois de Produtos, como as irmãs.
  assert(menu.indexOf("page: 'produtos'") < menu.indexOf("page: 'cadastro-categorias'")
      && menu.indexOf("page: 'cadastro-categorias'") < menu.indexOf("page: 'catalogo-etiquetas'"),
    'a posição no menu mudou — deveria ficar entre Produtos e Etiquetas');

  // Fail-closed: sem entrada no mapa, o perfil restrito toma 403.
  const mapa = fs.readFileSync(path.join(RAIZ, 'perfis-api-map.js'), 'utf8');
  const linha = /'\/api\/produto-lookup':\s*\[([^\]]*)\]/.exec(mapa);
  assert(linha && linha[1].includes("'cadastro-categorias'"),
    'cadastro-categorias não pode chamar /api/produto-lookup — a tela daria 403');
  const linhaProd = /'\/api\/produtos':\s*\[([^\]]*)\]/.exec(mapa);
  assert(linhaProd && linhaProd[1].includes("'cadastro-categorias'"),
    'cadastro-categorias não pode chamar /api/produtos — a contagem daria 403');
});

t('U. nenhuma migration: o schema nao mudou', () => {
  // A fase inteira roda sobre a estrutura que já existia.
  const cols = new Set(execFileSync('sqlite3', [`file:${ORIGEM}?mode=ro`,
    "SELECT name FROM pragma_table_info('produto_lookup');"]).toString().trim().split('\n'));
  for (const c of ['id', 'tipo', 'valor', 'ativo', 'dataCriacao']) {
    assert(cols.has(c), `a coluna ${c} sumiu de produto_lookup`);
  }
  assert(!cols.has('ordem'), 'apareceu a coluna `ordem` — esta fase é ordenação alfabética');
  const schema = fs.readFileSync(path.join(RAIZ, 'db-schema.js'), 'utf8');
  assert(!/produto_categorias/.test(schema), 'foi criada uma segunda estrutura de categorias');
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
