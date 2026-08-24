/**
 * Teste do cadastro/histórico de equipamento + correções dos relatórios
 * de OS (lucratividade quebrada, precedência no por-equipamento) e do
 * custo real (peça, horas, mão de obra).
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasOS } = require('../os-routes');

const DB = '/tmp/vp-equip.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-equip-schema.sql', 'utf8');
// O dump traz os schemas REAIS de tudo que o detalhe da OS junta. Stub
// genérico só para o que sobrar de FK — inventar colunas vira caça ao
// erro seguinte a cada rodada.
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
db.exec(`CREATE TABLE IF NOT EXISTS tipos_operacao (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, ativo INTEGER DEFAULT 1);
         CREATE TABLE IF NOT EXISTS participacoes_comprasnet (id INTEGER PRIMARY KEY AUTOINCREMENT);`);

const app = express();
registrarRotasOS(app, db);
const achar = (path, metodo) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === path && x.route.methods[metodo]);
  if (!l) throw new Error(`rota nao registrada: ${metodo.toUpperCase()} ${path}`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const hOS = achar('/api/os', 'post');
const hOSDet = achar('/api/os/:id', 'get');
const hEqList = achar('/api/equipamentos', 'get');
const hEqGet = achar('/api/equipamentos/:id', 'get');
const hEqPost = achar('/api/equipamentos', 'post');
const hEqPut = achar('/api/equipamentos/:id', 'put');
const hGar = achar('/api/os/garantia-sugestoes', 'get');
const hLucro = achar('/api/os/relatorios/lucratividade', 'get');
const hPorEquip = achar('/api/os/relatorios/por-equipamento', 'get');
const hPorTec = achar('/api/os/relatorios/por-tecnico', 'get');
const hPorCli = achar('/api/os/relatorios/por-cliente', 'get');

function chamar(handler, { params = {}, body = {}, query = {} } = {}) {
  let out = null, st = 200;
  const res = { json: o => { out = o; return res; }, status: c => { st = c; return res; } };
  handler({ params, body, query, session: { username: 'teste' }, user: { username: 'teste' } }, res);
  if (!out) throw new Error('sem resposta');
  return { out, st };
}

let ok = 0, fail = 0;
function t(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }

// ---------- seed ----------
db.prepare("INSERT INTO users (id, username, passwordHash, nome, role, ativo, valorHora) VALUES (1,'tec','x','Técnico','admin',1,50)").run();
db.prepare("INSERT INTO users (id, username, passwordHash, nome, role, ativo) VALUES (2,'semhora','x','Sem Hora','admin',1)").run();
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (1,'00000000000191','Cliente A','cliente',1)").run();
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo, ativo) VALUES (2,'00000000000272','Cliente B','cliente',1)").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, ativo, precoCusto) VALUES (1,'PC1','Peça 1',1,30)").run();

// ---------- cadastro e identidade ----------
let EQ1;
t('OS cria o equipamento a partir dos textos', () => {
  const r = chamar(hOS, { body: { clienteId: 1, titulo: 'Conserto',
    equipamento: 'Notebook', marca: 'Dell', modelo: 'G15', numeroSerieEquipamento: 'ABC-123' } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(r.out.os?.id || r.out.id);
  assert(os.equipamentoId, 'OS ficou sem equipamentoId');
  EQ1 = os.equipamentoId;
  const eq = db.prepare('SELECT * FROM equipamentos WHERE id = ?').get(EQ1);
  assert(eq.numeroSerie === 'ABC-123', 'série: ' + eq.numeroSerie);
  assert(eq.clienteId === 1, 'cliente: ' + eq.clienteId);
});

t('série com formatação diferente reaproveita o MESMO equipamento', () => {
  // Era exatamente isso que quebrava a garantia por string.
  const r = chamar(hOS, { body: { clienteId: 1, titulo: 'Volta',
    equipamento: 'Notebook', marca: 'Dell', modelo: 'G15', numeroSerieEquipamento: 'abc 123' } });
  const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(r.out.os?.id || r.out.id);
  assert(os.equipamentoId === EQ1, `deveria reusar ${EQ1}, veio ${os.equipamentoId}`);
  assert(db.prepare('SELECT COUNT(*) n FROM equipamentos').get().n === 1, 'duplicou equipamento');
});

t('equipamento sem série casa por marca+modelo+descrição', () => {
  const a = chamar(hOS, { body: { clienteId: 2, titulo: 'A', equipamento: 'Impressora', marca: 'HP', modelo: 'M404' } });
  const b = chamar(hOS, { body: { clienteId: 2, titulo: 'B', equipamento: 'Impressora', marca: 'HP', modelo: 'M404' } });
  const osA = db.prepare('SELECT equipamentoId FROM os_ordens WHERE id = ?').get(a.out.os?.id || a.out.id);
  const osB = db.prepare('SELECT equipamentoId FROM os_ordens WHERE id = ?').get(b.out.os?.id || b.out.id);
  assert(osA.equipamentoId === osB.equipamentoId, 'criou dois equipamentos iguais');
});

t('mesma série em outro cliente registra troca de dono', () => {
  const r = chamar(hOS, { body: { clienteId: 2, titulo: 'Trocou de dono',
    equipamento: 'Notebook', marca: 'Dell', modelo: 'G15', numeroSerieEquipamento: 'ABC123' } });
  const os = db.prepare('SELECT equipamentoId FROM os_ordens WHERE id = ?').get(r.out.os?.id || r.out.id);
  assert(os.equipamentoId === EQ1, 'deveria ser o mesmo equipamento');
  const eq = db.prepare('SELECT clienteId FROM equipamentos WHERE id = ?').get(EQ1);
  assert(eq.clienteId === 2, 'dono não atualizou: ' + eq.clienteId);
  const ev = db.prepare("SELECT * FROM equipamento_eventos WHERE equipamentoId=? AND tipo='troca_dono'").get(EQ1);
  assert(ev && ev.clienteAnteriorId === 1 && ev.clienteNovoId === 2, 'evento: ' + JSON.stringify(ev));
});

t('POST /api/equipamentos cria e reaproveita', () => {
  const novo = chamar(hEqPost, { body: { clienteId: 1, descricao: 'Servidor', marca: 'HPE', numeroSerie: 'S-9', patrimonio: 'PAT-1' } });
  assert(novo.out.success && novo.out.criado === true, 'não criou: ' + novo.out.error);
  assert(novo.out.equipamento.patrimonio === 'PAT-1', 'patrimônio não gravou');
  const repetido = chamar(hEqPost, { body: { clienteId: 1, descricao: 'Servidor', marca: 'HPE', numeroSerie: 's9' } });
  assert(repetido.out.criado === false, 'duplicou com série equivalente');
  assert(repetido.out.id === novo.out.id, 'ids diferentes');
});

t('busca por série, marca ou patrimônio', () => {
  const r = chamar(hEqList, { query: { q: 'PAT-1' } });
  assert(r.out.equipamentos.length === 1, 'busca por patrimônio: ' + r.out.equipamentos.length);
  assert(chamar(hEqList, { query: { q: 'Dell' } }).out.equipamentos.length === 1, 'busca por marca');
  assert(chamar(hEqList, { query: { clienteId: '2' } }).out.equipamentos.length >= 1, 'filtro por cliente');
});

t('PUT registra troca de dono como evento', () => {
  const eq = db.prepare("SELECT id, clienteId FROM equipamentos WHERE numeroSerie='S-9'").get();
  chamar(hEqPut, { params: { id: String(eq.id) }, body: { clienteId: 2, motivoTroca: 'Venda entre empresas' } });
  const ev = db.prepare("SELECT * FROM equipamento_eventos WHERE equipamentoId=? AND tipo='troca_dono'").get(eq.id);
  assert(ev && /Venda entre empresas/.test(ev.descricao), 'evento: ' + JSON.stringify(ev));
});

// ---------- histórico e garantia ----------
t('ficha traz histórico, contadores e reincidência', () => {
  const r = chamar(hEqGet, { params: { id: String(EQ1) } });
  assert(r.out.success, 'falhou: ' + r.out.error);
  assert(r.out.resumo.totalOS === 3, 'total de OS: ' + r.out.resumo.totalOS);
  assert(r.out.ordens.length === 3, 'ordens: ' + r.out.ordens.length);
  assert(Array.isArray(r.out.eventos) && r.out.eventos.length >= 2, 'eventos: ' + r.out.eventos.length);
});

t('garantia sai do equipamento, sem depender do texto', () => {
  const osId = db.prepare('SELECT id FROM os_ordens WHERE equipamentoId = ? ORDER BY id LIMIT 1').get(EQ1).id;
  db.prepare(`UPDATE os_ordens SET status='faturada', dataFaturamento=date('now','-10 days'),
    garantiaDias=90, valorTotal=500 WHERE id=?`).run(osId);
  const r = chamar(hGar, { query: { equipamentoId: String(EQ1) } });
  assert(r.out.success && r.out.fonte === 'equipamento', 'fonte: ' + r.out.fonte);
  assert(r.out.sugestoes.length === 1, 'sugestões: ' + r.out.sugestoes.length);
  // 90 dias de garantia, faturada há 10: sobram ~80. O piso da divisão faz
  // cair para 79 dependendo da hora do dia, então a faixa é o que importa.
  const dias = r.out.sugestoes[0].diasRestantes;
  assert(dias === 79 || dias === 80, 'dias restantes fora da faixa: ' + dias);
});

t('nova OS do equipamento entra em garantia sozinha', () => {
  const r = chamar(hOS, { body: { clienteId: 2, titulo: 'Voltou com defeito',
    equipamentoId: EQ1, equipamento: 'Notebook', marca: 'Dell', modelo: 'G15' } });
  const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(r.out.os?.id || r.out.id);
  assert(os.emGarantia === 1, 'não detectou garantia sem osPaiId');
  assert(os.osPaiId, 'não vinculou a OS de origem');
  assert(os.ambienteFiscal === 'interno', 'OS de garantia não deveria cobrar: ' + os.ambienteFiscal);
});

t('detalhe da OS traz o histórico do equipamento', () => {
  const osId = db.prepare('SELECT id FROM os_ordens WHERE equipamentoId = ? ORDER BY id DESC LIMIT 1').get(EQ1).id;
  const r = chamar(hOSDet, { params: { id: String(osId) } });
  assert(r.out.equipamentoFicha, 'ficha ausente');
  assert(r.out.equipamentoFicha.resumo.totalOS === 4, 'total: ' + r.out.equipamentoFicha.resumo.totalOS);
  assert(r.out.equipamentoFicha.garantiaVigente, 'garantia vigente não veio');
  assert(!r.out.equipamentoFicha.historico.some(h => h.id === osId), 'histórico não deveria incluir a própria OS');
});

// ---------- relatórios ----------
t('lucratividade não quebra mais (era 500 por pr.custoMedio)', () => {
  const r = chamar(hLucro, {});
  assert(r.out.success, 'ainda quebra: ' + r.out.error);
  assert(Array.isArray(r.out.linhas), 'sem linhas');
  assert(r.out.totais, 'sem totais');
});

t('lucratividade usa o custo gravado na peça e a mão de obra', () => {
  const osId = db.prepare("SELECT id FROM os_ordens WHERE status='faturada' LIMIT 1").get().id;
  db.prepare(`UPDATE os_ordens SET tecnicoId=1, valorPecas=200, valorServicos=300, valorTotal=500 WHERE id=?`).run(osId);
  db.prepare(`INSERT INTO os_itens_pecas (osId, produtoId, descricao, quantidade, valorUnitario, valorTotal, custoUnitario)
    VALUES (?,1,'Peça',2,100,200,40)`).run(osId);
  db.prepare(`INSERT INTO os_apontamentos (osId, tecnicoId, dataInicio, horas) VALUES (?,1,date('now'),3)`).run(osId);
  db.prepare(`INSERT INTO os_itens_servicos (osId, descricao, horas, valorHora, valorTotal) VALUES (?,'MO',2,150,300)`).run(osId);

  const l = chamar(hLucro, {}).out.linhas.find(x => x.osId === osId);
  assert(l.custoPecas === 80, 'custo peças (2×40): ' + l.custoPecas);
  assert(l.custoMaoDeObra === 150, 'custo MO (3h × 50): ' + l.custoMaoDeObra);
  assert(l.margemBruta === 420, 'margem bruta (500−80): ' + l.margemBruta);
  assert(l.margemLiquida === 270, 'margem líquida (500−80−150): ' + l.margemLiquida);
  assert(l.horasApontadas === 3 && l.horasCobradas === 2, 'horas: ' + l.horasApontadas + '/' + l.horasCobradas);
  assert(l.horasNaoCobradas === 1, 'horas não cobradas: ' + l.horasNaoCobradas);
});

t('sem valorHora do técnico o relatório avisa em vez de fingir lucro', () => {
  const osId = db.prepare("SELECT id FROM os_ordens WHERE status='faturada' LIMIT 1").get().id;
  db.prepare('UPDATE os_ordens SET tecnicoId = 2 WHERE id = ?').run(osId);
  const r = chamar(hLucro, {});
  const l = r.out.linhas.find(x => x.osId === osId);
  assert(l.custoMaoDeObra === 0, 'MO sem valorHora deveria ser 0');
  assert(l.custoMaoDeObraEstimado === false, 'deveria sinalizar ausência');
  assert(r.out.totais.semValorHora >= 1, 'totais deveriam contar: ' + r.out.totais.semValorHora);
  db.prepare('UPDATE os_ordens SET tecnicoId = 1 WHERE id = ?').run(osId);
});

t('por-equipamento respeita o filtro de período (bug de precedência)', () => {
  const total = chamar(hPorEquip, {}).out.linhas.length;
  assert(total > 0, 'sem linhas para comparar');
  const futuro = chamar(hPorEquip, { query: { de: '2099-01-01' } }).out.linhas.length;
  assert(futuro === 0, `período impossível deveria zerar, veio ${futuro} linha(s)`);
});

t('por-equipamento agrupa por equipamento, não por texto digitado', () => {
  const linhas = chamar(hPorEquip, {}).out.linhas;
  const doEq1 = linhas.filter(l => l.equipamentoId === EQ1);
  assert(doEq1.length === 1, `EQ1 deveria ser 1 linha só, veio ${doEq1.length}`);
  assert(doEq1[0].totalOS === 4, 'OS agrupadas: ' + doEq1[0].totalOS);
  assert(doEq1[0].clientes === 2, 'clientes distintos: ' + doEq1[0].clientes);
});

t('por-tecnico traz custo, margem e aproveitamento de horas', () => {
  const l = chamar(hPorTec, {}).out.linhas.find(x => x.tecnicoId === 1);
  assert(l, 'técnico sumiu');
  assert(l.custoPecas === 80, 'custo peças: ' + l.custoPecas);
  assert(l.custoMaoDeObra === 150, 'custo MO: ' + l.custoMaoDeObra);
  assert(l.margem === 270, 'margem: ' + l.margem);
  assert(l.aproveitamentoHoras === 66.7, 'aproveitamento (2/3): ' + l.aproveitamentoHoras);
  assert(l.horasNaoCobradas === 1, 'horas não cobradas: ' + l.horasNaoCobradas);
});

t('por-cliente também traz custo, margem e reincidência', () => {
  const l = chamar(hPorCli, {}).out.linhas.find(x => x.clienteId === 1);
  assert(l, 'cliente sumiu do relatório');
  assert(l.custoPecas === 80, 'custo peças: ' + l.custoPecas);
  assert(l.custoMaoDeObra === 150, 'custo MO: ' + l.custoMaoDeObra);
  assert(l.margem === 270, 'margem: ' + l.margem);
  assert(l.horasNaoCobradas === 1, 'horas não cobradas: ' + l.horasNaoCobradas);
  assert(l.osPorEquipamento != null, 'reincidência por equipamento ausente');
});

t('migração é idempotente (registrar rotas 2x não quebra)', () => {
  const app2 = express();
  registrarRotasOS(app2, db);
  assert(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='equipamentos'").get().n === 1, 'tabela duplicada');
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
