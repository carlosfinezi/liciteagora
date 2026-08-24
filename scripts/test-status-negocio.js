/**
 * Status do negócio — e o defeito que motivou esta suíte.
 *
 * O painel afirmava "catálogo sem licitação nova há 71 dias" enquanto o
 * catálogo recebia 3 a 4,5 mil por dia útil. Ele lia a cópia SQLite,
 * congelada na migração para o Postgres em 2026-05-23. Um alerta confiante
 * sobre a fonte errada manda investigar uma parada que não existe.
 *
 * As demais checagens cobrem armadilhas já pagas neste código:
 *   - grupo de EXCLUSÃO tem ativo=1 e não é grupo de busca;
 *   - inclusões e exclusões não podem ir na mesma expressão websearch;
 *   - encerramento efetivo é COALESCE(portal, proposta);
 *   - validade de certificado vem em dd/mm/aaaa, não ISO;
 *   - sábado sem publicação não é coleta quebrada.
 */
const fs = require('fs');
const Database = require('better-sqlite3');

// Sem CATALOG_BACKEND_PG: exercita o caminho SQLite, onde o catálogo é
// tabela local. O caminho PG é o mesmo código com outro tradutor de SQL.
delete process.env.CATALOG_BACKEND_PG;
const neg = require('../status-negocio');

const DB = '/tmp/vp-status.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);

db.exec(`
CREATE TABLE licitacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cnpj TEXT, anoCompra INTEGER, sequencialCompra INTEGER,
  razaoSocial TEXT, ufSigla TEXT, objetoCompra TEXT,
  valorTotalEstimado REAL,
  dataPublicacaoPncp TEXT,
  dataEncerramentoProposta TEXT,
  dataEncerramentoPortal TEXT
);
CREATE TABLE interesse (id INTEGER PRIMARY KEY AUTOINCREMENT, cnpj TEXT, ano INTEGER, sequencial INTEGER, dataCriacao TEXT);
CREATE TABLE sem_interesse (id INTEGER PRIMARY KEY AUTOINCREMENT, cnpj TEXT, ano INTEGER, sequencial INTEGER, dataCriacao TEXT);
CREATE TABLE licitacao_lida (id INTEGER PRIMARY KEY AUTOINCREMENT, dataLeitura TEXT);
CREATE TABLE licitacao_analise (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cnpj TEXT, ano INTEGER, sequencial INTEGER,
  viabilidade_score INTEGER, produto_compativel INTEGER, dataAnalise TEXT);
CREATE TABLE grupos_palavras (id INTEGER PRIMARY KEY, nome TEXT, tipo TEXT DEFAULT 'pesquisa', ativo INTEGER DEFAULT 1);
CREATE TABLE grupos_palavras_itens (grupoId INTEGER, palavra TEXT);
CREATE TABLE grupos_pesquisa_exclusao (grupoPesquisaId INTEGER, grupoExclusaoId INTEGER);
CREATE TABLE analise_ia_agendamento (grupoId INTEGER PRIMARY KEY, ativo INTEGER, limite_diario INTEGER,
  ultimo_scan_em TEXT, ultimo_scan_status TEXT);
CREATE TABLE certificado_digital (id INTEGER PRIMARY KEY, titular TEXT, validade TEXT);
`);

const HOJE = '2026-08-02';           // domingo
const SEXTA = '2026-07-31';

let ok = 0, fail = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(a === b, `${m} (esperado ${b}, veio ${a})`);

// ---------- massa ----------
const lic = db.prepare(`INSERT INTO licitacoes
  (cnpj, anoCompra, sequencialCompra, razaoSocial, ufSigla, objetoCompra,
   valorTotalEstimado, dataPublicacaoPncp, dataEncerramentoProposta, dataEncerramentoPortal)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);

// aberta, analisada, sem decisão
lic.run('111', 2026, 1, 'PREF A', 'SP', 'aquisicao de servidor rack', 1000, `${HOJE}T08:00:00Z`, '2026-08-20T10:00:00Z', null);
// encerrada, analisada, sem decisão
lic.run('111', 2026, 2, 'PREF B', 'MG', 'aquisicao de nobreak', 2000, '2026-07-01T08:00:00Z', '2026-07-10T10:00:00Z', null);
// aberta pelo PORTAL: proposta já passou, portal adiou
lic.run('111', 2026, 3, 'PREF C', 'RJ', 'licenca de software', 3000, '2026-07-05T08:00:00Z', '2026-07-20T10:00:00Z', '2026-08-25T10:00:00Z');
// marcada como interesse, encerrando em 2 dias
lic.run('222', 2026, 9, 'PREF D', 'PR', 'certificado ssl', 4000, '2026-07-20T08:00:00Z', '2026-08-04T10:00:00Z', null);
// marcada como interesse, prazo já passou
lic.run('222', 2026, 8, 'PREF E', 'SC', 'hospedagem', 5000, '2026-07-01T08:00:00Z', '2026-07-25T10:00:00Z', null);

const analise = db.prepare('INSERT INTO licitacao_analise (cnpj, ano, sequencial, viabilidade_score, dataAnalise) VALUES (?,?,?,?,?)');
analise.run('111', 2026, 1, 70, `${HOJE} 09:00:00`);
analise.run('111', 2026, 2, 80, '2026-06-20 09:00:00');
analise.run('111', 2026, 3, 95, '2026-07-06 09:00:00');
analise.run('222', 2026, 9, 60, '2026-07-21 09:00:00');   // decidida (interesse)

db.prepare('INSERT INTO interesse (cnpj, ano, sequencial, dataCriacao) VALUES (?,?,?,?)').run('222', 2026, 9, '2026-07-21');
db.prepare('INSERT INTO interesse (cnpj, ano, sequencial, dataCriacao) VALUES (?,?,?,?)').run('222', 2026, 8, '2026-07-02');

db.exec(`
INSERT INTO grupos_palavras (id, nome, tipo, ativo) VALUES
  (1, 'SERVIDORES', 'pesquisa', 1),
  (2, 'EXCLUI NAS', 'exclusao', 1),
  (3, 'GRUPO VAZIO', 'pesquisa', 1),
  (4, 'DESATIVADO', 'pesquisa', 0);
INSERT INTO grupos_palavras_itens (grupoId, palavra) VALUES
  (1, 'servidor'), (1, 'storage'), (2, 'nas'), (2, 'synology');
INSERT INTO grupos_pesquisa_exclusao (grupoPesquisaId, grupoExclusaoId) VALUES (1, 2);
INSERT INTO analise_ia_agendamento (grupoId, ativo, limite_diario, ultimo_scan_em, ultimo_scan_status)
  VALUES (1, 1, 100, '2026-08-02 09:50:00', 'sucesso');
`);

(async () => {
console.log('\n== catálogo: a fonte tem de ser declarada ==');

await t('frescor declara a fonte que leu', async () => {
  const f = await neg.frescorDoCatalogo(db, { hoje: HOJE });
  eq(f.fonte, 'sqlite', 'fonte');
});

await t('frescor conta o que entrou na janela de 7 dias', async () => {
  const f = await neg.frescorDoCatalogo(db, { hoje: HOJE });
  eq(f.publicadasHoje, 1, 'publicadas hoje');
  eq(f.publicadas7d, 1, 'publicadas em 7 dias');
  eq(f.diasSemPublicacaoNova, 0, 'dias sem publicação');
});

await t('domingo sem publicação não vira alerta de coleta parada', async () => {
  const f = await neg.frescorDoCatalogo(db, { hoje: '2026-08-09' });
  assert(f.fimDeSemana === true, 'domingo deveria ser marcado como fim de semana');
});

await t('dia útil é sinalizado como dia útil', async () => {
  const f = await neg.frescorDoCatalogo(db, { hoje: SEXTA });
  assert(f.fimDeSemana === false, 'sexta não é fim de semana');
});

console.log('\n== oportunidade qualificada ==');

await t('separa aberta de encerrada e ignora a já decidida', async () => {
  const o = await neg.qualificadasSemDecisao(db, { hoje: HOJE });
  eq(o.analisadas, 4, 'analisadas');
  eq(o.semDecisao, 3, 'sem decisão (a de interesse sai)');
  eq(o.abertas, 2, 'abertas');
  eq(o.encerradasSemDecisao, 1, 'encerradas sem decisão');
});

await t('encerramento do PORTAL prevalece sobre o da proposta', async () => {
  const o = await neg.qualificadasSemDecisao(db, { hoje: HOJE });
  const c = o.amostra.find((x) => x.sequencial === 3);
  assert(c, 'a licitação adiada pelo portal deveria contar como aberta');
  eq(c.encerra, '2026-08-25', 'data efetiva');
});

await t('amostra vem ordenada pelo score da IA', async () => {
  const o = await neg.qualificadasSemDecisao(db, { hoje: HOJE });
  eq(o.amostra[0].sequencial, 3, 'primeira da amostra (score 95)');
});

await t('soma o valor só do que está aberto', async () => {
  const o = await neg.qualificadasSemDecisao(db, { hoje: HOJE });
  eq(o.valorAberto, 4000, 'valor aberto (1000 + 3000)');
});

await t('declara a cobertura em vez de sugerir varredura total', async () => {
  const o = await neg.qualificadasSemDecisao(db, { hoje: HOJE });
  assert(o.cobertura && o.cobertura.ativa === true, 'cobertura ativa');
  eq(o.cobertura.tetoDiario, 100, 'teto diário');
  eq(o.cobertura.comFalha, 0, 'grupos com falha');
});

await t('scan com falha é reportado', async () => {
  db.prepare("UPDATE analise_ia_agendamento SET ultimo_scan_status = 'erro' WHERE grupoId = 1").run();
  const c = neg.coberturaDaDescoberta(db);
  eq(c.comFalha, 1, 'grupos com falha');
  db.prepare("UPDATE analise_ia_agendamento SET ultimo_scan_status = 'sucesso' WHERE grupoId = 1").run();
});

await t('análise cuja licitação sumiu do catálogo é declarada, não some na conta', async () => {
  analise.run('999', 2026, 77, 50, '2026-07-01 09:00:00');
  const o = await neg.qualificadasSemDecisao(db, { hoje: HOJE });
  eq(o.naoEncontradasNoCatalogo, 1, 'não encontradas');
  eq(o.semDecisao, o.abertas + o.encerradasSemDecisao + o.naoEncontradasNoCatalogo, 'a conta fecha');
  db.prepare('DELETE FROM licitacao_analise WHERE cnpj = ?').run('999');
});

console.log('\n== prazos ==');

await t('interesse encerrando em 2 dias entra em vencendo', async () => {
  const p = await neg.prazos(db, { hoje: HOJE, dias: 3 });
  eq(p.vencendo.length, 1, 'vencendo');
  eq(p.vencendo[0].sequencial, 9, 'qual');
});

await t('interesse com prazo passado entra em vencidos', async () => {
  const p = await neg.prazos(db, { hoje: HOJE, diasVencidos: 15 });
  eq(p.vencidos.length, 1, 'vencidos');
  eq(p.vencidos[0].sequencial, 8, 'qual');
});

await t('vencido antigo demais sai da janela', async () => {
  const p = await neg.prazos(db, { hoje: HOJE, diasVencidos: 2 });
  eq(p.vencidos.length, 0, 'vencidos fora da janela');
});

console.log('\n== grupos ==');

await t('grupo de EXCLUSÃO ativo não é tratado como grupo de busca', async () => {
  const r = await neg.grupoImprodutivo(db, { hoje: HOJE, dias: 30 });
  assert(!r.grupos.some((g) => g.id === 2), 'grupo de exclusão não deveria ser avaliado');
});

await t('grupo desativado não é avaliado', async () => {
  const r = await neg.grupoImprodutivo(db, { hoje: HOJE, dias: 30 });
  assert(!r.grupos.some((g) => g.id === 4), 'grupo inativo não deveria ser avaliado');
});

await t('grupo ativo sem palavra é reportado', async () => {
  const r = await neg.grupoImprodutivo(db, { hoje: HOJE, dias: 30 });
  const g = r.grupos.find((x) => x.id === 3);
  assert(g && /sem nenhuma palavra/.test(g.motivo), 'grupo vazio deveria ser reportado');
});

await t('escopo do casamento é declarado', async () => {
  const r = await neg.grupoImprodutivo(db, { hoje: HOJE, dias: 30 });
  assert(/não inclui descrição dos itens/.test(r.escopo), 'escopo deveria dizer o que fica de fora');
});

await t('inclusões e exclusões saem SEPARADAS da expressão', () => {
  const e = neg.expressaoDoGrupo(db, 1);
  eq(e.incl, 'servidor OR storage', 'inclusões');
  eq(e.excl, 'nas OR synology', 'exclusões');
  assert(!e.incl.includes('nas'), 'exclusão não pode vazar para a inclusão');
});

await t('expressão de grupo sem palavra é nula', () => {
  assert(neg.expressaoDoGrupo(db, 3) === null, 'grupo vazio deveria devolver null');
});

await t('frase com espaço vai entre aspas', () => {
  db.prepare('INSERT INTO grupos_palavras_itens (grupoId, palavra) VALUES (?,?)').run(1, 'storage enterprise');
  const e = neg.expressaoDoGrupo(db, 1);
  assert(e.incl.includes('"storage enterprise"'), 'frase deveria ser citada: ' + e.incl);
  db.prepare('DELETE FROM grupos_palavras_itens WHERE palavra = ?').run('storage enterprise');
});

console.log('\n== certificado ==');

await t('validade dd/mm/aaaa é entendida', () => {
  db.prepare('INSERT OR REPLACE INTO certificado_digital (id, titular, validade) VALUES (1, ?, ?)')
    .run('1BIT LTDA', '20/08/2026');
  const c = neg.certificado(db, { hoje: HOJE });
  eq(c.validade, '2026-08-20', 'validade normalizada');
  eq(c.diasParaVencer, 18, 'dias para vencer');
  assert(c.aVencer === true, 'deveria alertar');
});

await t('certificado vencido é marcado como vencido', () => {
  db.prepare('UPDATE certificado_digital SET validade = ? WHERE id = 1').run('01/07/2026');
  const c = neg.certificado(db, { hoje: HOJE });
  assert(c.vencido === true, 'deveria estar vencido');
  assert(c.diasParaVencer < 0, 'dias negativos');
});

console.log('\n== funil e painel ==');

await t('funil separa período de acumulado', () => {
  const f = neg.funil(db, { hoje: HOJE, dias: 30 });
  eq(f.analisadas, 4, 'análises acumuladas');
  eq(f.analisadasNoPeriodo, 3, 'análises no período');
  eq(f.interesses, 2, 'interesses distintos');
});

await t('painel monta sem quebrar e declara o backend', async () => {
  const p = await neg.painel(db, { hoje: HOJE });
  eq(p.backendCatalogo, 'sqlite', 'backend');
  assert(p.oportunidades && p.prazos && p.catalogo && p.funil && p.certificado, 'blocos do painel');
  eq(p.referencia, HOJE, 'referência');
});

await t('tenant sem análises não quebra o painel', async () => {
  const vazio = new Database(':memory:');
  const o = await neg.qualificadasSemDecisao(vazio, { hoje: HOJE });
  assert(o.disponivel === false, 'deveria informar indisponível, não estourar');
});

console.log(`\n${ok} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
})();
