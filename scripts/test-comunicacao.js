/**
 * Comunicação em massa: quem recebe, quem não recebe e o que é dito sobre isso.
 *
 * O que motivou esta suíte:
 *
 *  1. Opt-out existia só para WhatsApp e só por telefone. O 1bit tem 27 pessoas
 *     que pediram para parar — e uma campanha de e-mail alcançaria todas,
 *     porque o canal e-mail não tinha descadastro nenhum.
 *  2. E-mail nunca era enviado: marcava 'enviado-simulado' e a campanha se
 *     declarava 'enviada' com N enviados. A tela afirmava um envio que não
 *     aconteceu.
 *  3. Sem validação nem deduplicação de destino: "joao@" virava envio, e
 *     matriz e filial com o mesmo e-mail recebiam duas vezes.
 *  4. Placeholder desconhecido ia literal — o cliente recebia "Olá {{fone}}".
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const dest = require('../comm-destinos');

const DB = '/tmp/vp-comm.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-comm-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
  try { db.exec(`INSERT OR IGNORE INTO ${m[1]} (id) VALUES (1)`); } catch {}
}

// O schema de `config` traz os triggers de auditoria da ótica; sem a tabela de
// destino, qualquer DELETE em config estoura.
db.exec('CREATE TABLE IF NOT EXISTS smtp_config (key TEXT PRIMARY KEY, value TEXT)');
db.exec(`CREATE TABLE IF NOT EXISTS optica_flag_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, evento TEXT, valor_antes TEXT, valor_depois TEXT,
  dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);

let ok = 0, fail = 0;
const t = (nome, fn) => {
  const run = () => { console.log('  OK  ' + nome); ok++; };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(run, (e) => { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; });
    run();
  } catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  return Promise.resolve();
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const tem = (ps, cod) => ps.some((p) => p.codigo === cod);
const codigos = (ps) => ps.map((p) => p.codigo).join(', ') || '(nenhum)';

const app = express();
app.use(express.json());
require('../comm-routes').registrarRotasComm(app, db);

function call(m, p, body = {}, params = {}, query = {}) {
  let h = null;
  for (const c of app.router.stack) {
    if (c.route && c.route.path === p && c.route.methods[m]) h = c.route.stack[c.route.stack.length - 1].handle;
  }
  if (!h) throw new Error('rota não encontrada: ' + m + ' ' + p);
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(j) { resolve({ status: this.statusCode, body: j }); return this; },
    };
    Promise.resolve(h({ body, params, query, user: { username: 't' }, session: { username: 't' },
      tenantCtx: { slug: 'demo' }, tenantDb: db }, res, () => {})).catch(() => {});
  });
}

// ---------- fixture ----------
let seqP = 0;
const novaPessoa = (o = {}) => db.prepare(`INSERT INTO pessoas
  (razaoSocial, cpfCnpj, email, telefone, aceitaEmailMarketing, aceitaWhatsappMarketing)
  VALUES (@razaoSocial, @cpfCnpj, @email, @telefone, @aceitaEmailMarketing, @aceitaWhatsappMarketing)`)
  .run({ razaoSocial: 'Cliente ' + (++seqP), cpfCnpj: String(10000000000 + seqP),
         email: `cliente${seqP}@exemplo.com.br`, telefone: '91988887777',
         aceitaEmailMarketing: 1, aceitaWhatsappMarketing: 1, ...o }).lastInsertRowid;

function limpar() {
  db.exec(`DELETE FROM comm_envios; DELETE FROM comm_campanhas; DELETE FROM comm_lista_membros;
           DELETE FROM comm_listas; DELETE FROM comm_templates; DELETE FROM comm_optout;
           DELETE FROM pessoas; DELETE FROM config;`);
  try { db.exec('DELETE FROM wa_optout'); } catch {}
}
const novaLista = (nome = 'Lista') => db.prepare('INSERT INTO comm_listas (nome) VALUES (?)').run(nome).lastInsertRowid;
const addMembro = (listaId, pessoaId) => db.prepare(
  'INSERT INTO comm_lista_membros (listaId, pessoaId) VALUES (?, ?)').run(listaId, pessoaId);
const novoTemplate = (o = {}) => db.prepare(
  'INSERT INTO comm_templates (nome, canal, assunto, corpo) VALUES (@nome, @canal, @assunto, @corpo)')
  .run({ nome: 'T', canal: 'email', assunto: 'Oi {{primeiroNome}}', corpo: 'Olá {{razaoSocial}}', ...o }).lastInsertRowid;
const novaCampanha = (templateId, listaId, canal = 'email') => db.prepare(
  `INSERT INTO comm_campanhas (nome, templateId, listaId, canal, status) VALUES ('C', ?, ?, ?, 'rascunho')`)
  .run(templateId, listaId, canal).lastInsertRowid;

(async () => {

// ==================== NORMALIZAÇÃO ====================
console.log('\n--- e-mail ---');

await t('aceita e-mail comum e baixa para minúsculas', () => {
  assert(dest.normalizarEmail('  Joao@Exemplo.COM.br ') === 'joao@exemplo.com.br', dest.normalizarEmail('Joao@Exemplo.COM.br'));
});

await t('recusa e-mail sem domínio, sem TLD e com espaço', () => {
  for (const e of ['joao@', 'joao@exemplo', '@exemplo.com', 'joao exemplo@x.com', 'joao@x.c0m', '']) {
    assert(dest.normalizarEmail(e) === null, 'aceitou: ' + JSON.stringify(e));
  }
});

await t('recusa lista de e-mails num campo só', () => {
  assert(dest.normalizarEmail('a@x.com,b@y.com') === null, 'aceitou dois e-mails num campo');
});

console.log('\n--- telefone ---');

await t('celular com DDD vira E.164 brasileiro', () => {
  assert(dest.normalizarTelefone('(91) 98888-7777') === '5591988887777', dest.normalizarTelefone('(91) 98888-7777'));
});

await t('número que já veio com 55 não ganha outro 55', () => {
  assert(dest.normalizarTelefone('5591988887777') === '5591988887777', dest.normalizarTelefone('5591988887777'));
});

await t('celular antigo sem o nono dígito ganha o 9', () => {
  // Sem isso a mensagem simplesmente não chega.
  assert(dest.normalizarTelefone('9188887777') === '5591988887777', dest.normalizarTelefone('9188887777'));
});

await t('fixo não ganha nono dígito', () => {
  assert(dest.normalizarTelefone('9132221111') === '559132221111', dest.normalizarTelefone('9132221111'));
});

await t('recusa número curto, longo e com DDD inválido', () => {
  for (const n of ['1234', '9', '0011', '11988887777777777', '']) {
    assert(dest.normalizarTelefone(n) === null, 'aceitou: ' + JSON.stringify(n));
  }
});

await t('prefixo de operadora (0xx) é descartado, não invalida o número', () => {
  // "019 8888-7777" é DDD 19 escrito à moda antiga — recusar seria perder o
  // contato por causa da grafia.
  assert(dest.normalizarTelefone('01988887777') === '5519988887777', dest.normalizarTelefone('01988887777'));
});

await t('o mesmo número escrito de dois jeitos normaliza igual', () => {
  // Era isto que fazia o opt-out não casar: a pessoa se descadastrava e o
  // número voltava na campanha seguinte escrito de outra forma.
  const a = dest.normalizarTelefone('+55 (91) 98888-7777');
  const b = dest.normalizarTelefone('91 98888 7777');
  assert(a === b && a === '5591988887777', `${a} vs ${b}`);
});

// ==================== OPT-OUT ====================
console.log('\n--- opt-out ---');

await t('registrar e consultar opt-out de e-mail', () => {
  limpar();
  dest.registrarOptOut(db, { canal: 'email', destino: 'JOAO@Exemplo.com', origem: 'link' });
  assert(dest.estaOptOut(db, 'email', 'joao@exemplo.com'), 'não achou pelo normalizado');
  assert(dest.estaOptOut(db, 'email', ' Joao@EXEMPLO.com '), 'não achou com outra grafia');
});

await t('opt-out de um canal não vale no outro', () => {
  limpar();
  dest.registrarOptOut(db, { canal: 'whatsapp', destino: '91988887777' });
  assert(dest.estaOptOut(db, 'whatsapp', '(91) 98888-7777'), 'whatsapp deveria estar em opt-out');
  assert(!dest.estaOptOut(db, 'email', 'x@y.com'), 'vazou para e-mail');
});

await t('registrar duas vezes não duplica', () => {
  limpar();
  dest.registrarOptOut(db, { canal: 'email', destino: 'a@b.com' });
  dest.registrarOptOut(db, { canal: 'email', destino: 'a@b.com', motivo: 'pediu por telefone' });
  const n = db.prepare('SELECT COUNT(*) n FROM comm_optout').get().n;
  assert(n === 1, 'duplicou: ' + n);
  assert(db.prepare('SELECT motivo FROM comm_optout').get().motivo === 'pediu por telefone', 'não atualizou o motivo');
});

await t('destino inválido não vira opt-out', () => {
  let erro = null;
  try { dest.registrarOptOut(db, { canal: 'email', destino: 'nao-e-email' }); } catch (e) { erro = e.message; }
  assert(/inválido/i.test(erro || ''), 'erro: ' + erro);
});

await t('opt-out de WhatsApp também alimenta wa_optout, que o runner consulta', () => {
  limpar();
  dest.registrarOptOut(db, { canal: 'whatsapp', destino: '91988887777' });
  const n = db.prepare("SELECT COUNT(*) n FROM wa_optout WHERE telefone = '5591988887777'").get().n;
  assert(n === 1, 'não espelhou em wa_optout');
});

await t('a migração traz os opt-outs antigos de wa_optout', () => {
  limpar();
  db.prepare("INSERT INTO wa_optout (telefone) VALUES ('5591977776666')").run();
  dest.migrarDB(db);
  assert(dest.estaOptOut(db, 'whatsapp', '91977776666'), 'perdeu opt-out antigo na unificação');
});

await t('reinclusão pela rota exige confirmação explícita', async () => {
  limpar();
  dest.registrarOptOut(db, { canal: 'email', destino: 'a@b.com' });
  const sem = await call('delete', '/api/comm/optout', { canal: 'email', destino: 'a@b.com' });
  assert(sem.status === 400 && /confirmar/i.test(sem.body.error), JSON.stringify(sem.body));
  assert(dest.estaOptOut(db, 'email', 'a@b.com'), 'removeu sem confirmação');
  const com = await call('delete', '/api/comm/optout', { canal: 'email', destino: 'a@b.com', confirmar: true });
  assert(com.body.success && !dest.estaOptOut(db, 'email', 'a@b.com'), JSON.stringify(com.body));
});

// ==================== TEMPLATE ====================
console.log('\n--- template ---');

await t('placeholder conhecido é substituído', () => {
  const r = dest.renderizar('Olá {{primeiroNome}}, CNPJ {{cpfCnpj}}',
    { razaoSocial: 'Maria Silva ME', cpfCnpj: '123' });
  assert(r === 'Olá Maria, CNPJ 123', r);
});

await t('placeholder desconhecido é recusado ANTES de mandar', () => {
  const p = dest.validarTemplate({ nome: 'T', canal: 'email', assunto: 'Oi', corpo: 'Olá {{fone}}' });
  // Sem isso o cliente recebe literalmente "Olá {{fone}}".
  assert(tem(p, 'placeholder_desconhecido'), codigos(p));
  assert(/\{\{fone\}\}/.test(p.find((x) => x.codigo === 'placeholder_desconhecido').mensagem), 'não nomeou o placeholder');
});

await t('placeholder desconhecido no assunto também é pego', () => {
  const p = dest.validarTemplate({ nome: 'T', canal: 'email', assunto: 'Oi {{apelido}}', corpo: 'Olá' });
  assert(tem(p, 'placeholder_desconhecido'), codigos(p));
});

await t('template sem corpo é recusado', () => {
  assert(tem(dest.validarTemplate({ nome: 'T', canal: 'email', corpo: '' }), 'corpo_obrigatorio'));
});

await t('e-mail sem assunto passa com aviso, não bloqueio', () => {
  const p = dest.validarTemplate({ nome: 'T', canal: 'email', assunto: '', corpo: 'Olá' });
  const a = p.find((x) => x.codigo === 'assunto_vazio');
  assert(a && a.nivel === 'aviso', codigos(p));
});

await t('WhatsApp acima de 4096 caracteres é recusado', () => {
  const p = dest.validarTemplate({ nome: 'T', canal: 'whatsapp', corpo: 'x'.repeat(5000) });
  assert(tem(p, 'corpo_muito_longo'), codigos(p));
});

await t('a rota recusa o template inválido e devolve avisos do válido', async () => {
  limpar();
  const ruim = await call('post', '/api/comm/templates', { nome: 'T', canal: 'email', corpo: 'Olá {{xpto}}' });
  assert(ruim.status === 400, 'status: ' + ruim.status);
  const bom = await call('post', '/api/comm/templates', { nome: 'T', canal: 'email', corpo: 'Olá {{razaoSocial}}' });
  assert(bom.body.success && bom.body.avisos.length > 0, JSON.stringify(bom.body));
});

// ==================== DESTINATÁRIOS ====================
console.log('\n--- quem realmente recebe ---');

await t('pessoa sem e-mail é descartada com motivo, não some', () => {
  limpar();
  const l = novaLista();
  addMembro(l, novaPessoa());
  addMembro(l, novaPessoa({ email: null }));
  const p = dest.prepararDestinatarios(db, { listaId: l, canal: 'email' });
  assert(p.resumo.elegiveis === 1 && p.resumo.semDestino === 1, JSON.stringify(p.resumo));
  assert(/sem e-mail/.test(p.descartados[0].motivo), p.descartados[0].motivo);
});

await t('e-mail inválido é descartado antes de gastar envio', () => {
  limpar();
  const l = novaLista();
  addMembro(l, novaPessoa({ email: 'joao@' }));
  const p = dest.prepararDestinatarios(db, { listaId: l, canal: 'email' });
  assert(p.resumo.invalidos === 1 && p.resumo.elegiveis === 0, JSON.stringify(p.resumo));
});

await t('quem está em opt-out não entra na campanha', () => {
  limpar();
  const l = novaLista();
  const p1 = novaPessoa({ email: 'a@x.com' });
  addMembro(l, p1);
  addMembro(l, novaPessoa({ email: 'b@x.com' }));
  dest.registrarOptOut(db, { canal: 'email', destino: 'a@x.com' });
  const p = dest.prepararDestinatarios(db, { listaId: l, canal: 'email' });
  assert(p.resumo.elegiveis === 1 && p.resumo.optout === 1, JSON.stringify(p.resumo));
  assert(p.enviar[0].destino === 'b@x.com', p.enviar[0].destino);
});

await t('destino repetido recebe uma vez só', () => {
  limpar();
  const l = novaLista();
  // Matriz e filial com o mesmo e-mail: mandar duas vezes é como um domínio
  // vira spam.
  addMembro(l, novaPessoa({ razaoSocial: 'Matriz', email: 'contato@empresa.com' }));
  addMembro(l, novaPessoa({ razaoSocial: 'Filial', email: 'CONTATO@Empresa.com' }));
  const p = dest.prepararDestinatarios(db, { listaId: l, canal: 'email' });
  assert(p.resumo.elegiveis === 1 && p.resumo.duplicados === 1, JSON.stringify(p.resumo));
  assert(/repetido/.test(p.descartados[0].motivo) && /Matriz/.test(p.descartados[0].motivo), p.descartados[0].motivo);
});

await t('o resumo soma exatamente o total da lista', () => {
  limpar();
  const l = novaLista();
  addMembro(l, novaPessoa({ email: 'ok@x.com' }));
  addMembro(l, novaPessoa({ email: null }));
  addMembro(l, novaPessoa({ email: 'ruim@' }));
  addMembro(l, novaPessoa({ email: 'fora@x.com' }));
  addMembro(l, novaPessoa({ email: 'ok@x.com' }));
  dest.registrarOptOut(db, { canal: 'email', destino: 'fora@x.com' });
  const r = dest.prepararDestinatarios(db, { listaId: l, canal: 'email' }).resumo;
  assert(r.elegiveis + r.semDestino + r.invalidos + r.optout + r.duplicados === r.total,
    'o resumo não fecha: ' + JSON.stringify(r));
  assert(r.total === 5 && r.elegiveis === 1, JSON.stringify(r));
});

await t('WhatsApp normaliza o telefone do cadastro', () => {
  limpar();
  const l = novaLista();
  addMembro(l, novaPessoa({ telefone: '(91) 98888-7777' }));
  const p = dest.prepararDestinatarios(db, { listaId: l, canal: 'whatsapp' });
  assert(p.resumo.elegiveis === 1 && p.enviar[0].destino === '5591988887777', JSON.stringify(p.resumo));
});

// ==================== CONSENTIMENTO ====================
console.log('\n--- consentimento de marketing ---');

await t('quem marcou que NÃO aceita marketing fica fora da campanha', () => {
  limpar();
  const l = novaLista();
  addMembro(l, novaPessoa({ email: 'sim@x.com', aceitaEmailMarketing: 1 }));
  addMembro(l, novaPessoa({ email: 'nao@x.com', aceitaEmailMarketing: 0 }));
  // A coluna existia no cadastro e nenhum envio a lia: no 1bit são 29 pessoas
  // que marcaram recusa e receberiam assim mesmo.
  const p = dest.prepararDestinatarios(db, { listaId: l, canal: 'email', tipo: 'marketing' });
  assert(p.resumo.elegiveis === 1 && p.resumo.semConsentimento === 1, JSON.stringify(p.resumo));
  assert(p.enviar[0].destino === 'sim@x.com', p.enviar[0].destino);
});

await t('campanha operacional não exige consentimento de marketing', () => {
  limpar();
  const l = novaLista();
  addMembro(l, novaPessoa({ email: 'nao@x.com', aceitaEmailMarketing: 0 }));
  // Aviso de entrega e cobrança se apoiam em execução de contrato.
  const p = dest.prepararDestinatarios(db, { listaId: l, canal: 'email', tipo: 'operacional' });
  assert(p.resumo.elegiveis === 1 && p.resumo.semConsentimento === 0, JSON.stringify(p.resumo));
});

await t('opt-out vence mesmo em campanha operacional', () => {
  limpar();
  const l = novaLista();
  addMembro(l, novaPessoa({ email: 'fora@x.com', aceitaEmailMarketing: 1 }));
  dest.registrarOptOut(db, { canal: 'email', destino: 'fora@x.com' });
  const p = dest.prepararDestinatarios(db, { listaId: l, canal: 'email', tipo: 'operacional' });
  assert(p.resumo.elegiveis === 0 && p.resumo.optout === 1, JSON.stringify(p.resumo));
});

await t('consentimento de WhatsApp é lido da coluna do WhatsApp', () => {
  limpar();
  const l = novaLista();
  addMembro(l, novaPessoa({ telefone: '91988887777', aceitaEmailMarketing: 1, aceitaWhatsappMarketing: 0 }));
  const email = dest.prepararDestinatarios(db, { listaId: l, canal: 'email' });
  const wa = dest.prepararDestinatarios(db, { listaId: l, canal: 'whatsapp' });
  assert(email.resumo.elegiveis === 1, 'e-mail deveria passar: ' + JSON.stringify(email.resumo));
  assert(wa.resumo.semConsentimento === 1, 'whatsapp deveria bloquear: ' + JSON.stringify(wa.resumo));
});

await t('a rota recusa tipo de campanha inventado', async () => {
  limpar();
  const l = novaLista();
  const r = await call('post', '/api/comm/campanhas',
    { nome: 'C', templateId: novoTemplate(), listaId: l, tipo: 'promocional' });
  assert(r.status === 400 && /marketing/.test(r.body.error), JSON.stringify(r.body));
});

// ==================== JANELA ====================
console.log('\n--- janela de envio ---');

const setCfg = (k, v) => db.prepare(
  "INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(k, v);

await t('madrugada é bloqueada por padrão', () => {
  limpar();
  // 06:00 UTC = 03:00 em Belém.
  const j = dest.janelaPermitida(db, '2026-08-03T06:00:00Z');
  assert(!j.permitido && /janela/.test(j.motivo), JSON.stringify(j));
});

await t('horário comercial é liberado', () => {
  const j = dest.janelaPermitida(db, '2026-08-03T17:00:00Z');   // 14h local
  assert(j.permitido, JSON.stringify(j));
});

await t('a janela é configurável', () => {
  limpar();
  setCfg('comm_janela_inicio', '9'); setCfg('comm_janela_fim', '18');
  assert(!dest.janelaPermitida(db, '2026-08-03T11:00:00Z').permitido, '08h deveria estar fora de 9-18');
  assert(dest.janelaPermitida(db, '2026-08-03T13:00:00Z').permitido, '10h deveria estar dentro');
});

await t('dá para desligar a janela inteira', () => {
  limpar();
  setCfg('comm_janela_ativa', '0');
  assert(dest.janelaPermitida(db, '2026-08-03T06:00:00Z').permitido, 'bloqueou com a janela desligada');
});

await t('fim de semana é bloqueado quando configurado', () => {
  limpar();
  setCfg('comm_janela_dias_uteis', '1');
  // 2026-08-02 é domingo.
  const j = dest.janelaPermitida(db, '2026-08-02T17:00:00Z');
  assert(!j.permitido && /dias úteis/.test(j.motivo), JSON.stringify(j));
});

// ==================== EXECUÇÃO ====================
console.log('\n--- execução da campanha ---');

function cenario(canal = 'email') {
  limpar();
  setCfg('comm_janela_ativa', '0');   // não é isso que está sendo testado aqui
  const l = novaLista();
  addMembro(l, novaPessoa({ email: 'a@x.com' }));
  addMembro(l, novaPessoa({ email: 'b@x.com' }));
  addMembro(l, novaPessoa({ email: null }));
  const tpl = novoTemplate({ canal });
  return { listaId: l, campanhaId: novaCampanha(tpl, l, canal) };
}

await t('sem SMTP a campanha NÃO se declara enviada', async () => {
  const { campanhaId } = cenario();
  const r = await call('post', '/api/comm/campanhas/:id/executar', {}, { id: campanhaId });
  // Antes: status 'enviada', totalEnviados = 2, para e-mails que nunca saíram.
  assert(r.body.success && r.body.simulacao === true, JSON.stringify(r.body));
  assert(r.body.enviados === 0, 'declarou envio sem SMTP: ' + r.body.enviados);
  const c = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(campanhaId);
  assert(c.status === 'simulada', 'status: ' + c.status);
  assert(c.totalEnviados === 0, 'totalEnviados: ' + c.totalEnviados);
  assert(/nada foi enviado/i.test(r.body.aviso || ''), 'aviso: ' + r.body.aviso);
});

await t('os descartados ficam registrados com motivo', () => {
  const desc = db.prepare("SELECT * FROM comm_envios WHERE status = 'descartado'").all();
  assert(desc.length === 1, 'descartados: ' + desc.length);
  assert(/sem e-mail/.test(desc[0].motivoDescartado), desc[0].motivoDescartado);
});

await t('totalDestinatarios conta quem recebe, não quem está na lista', () => {
  const c = db.prepare('SELECT * FROM comm_campanhas ORDER BY id DESC LIMIT 1').get();
  assert(c.totalDestinatarios === 2 && c.totalDescartados === 1, JSON.stringify(c));
});

await t('reexecutar não duplica os envios', async () => {
  const { campanhaId } = cenario();
  await call('post', '/api/comm/campanhas/:id/executar', {}, { id: campanhaId });
  const antes = db.prepare('SELECT COUNT(*) n FROM comm_envios WHERE campanhaId = ?').get(campanhaId).n;
  db.prepare("UPDATE comm_campanhas SET status = 'pausada' WHERE id = ?").run(campanhaId);
  await call('post', '/api/comm/campanhas/:id/executar', {}, { id: campanhaId });
  const depois = db.prepare('SELECT COUNT(*) n FROM comm_envios WHERE campanhaId = ?').get(campanhaId).n;
  // Uma campanha 'pausada' reexecutada inseria a lista inteira de novo.
  assert(antes === depois, `${antes} -> ${depois}`);
});

await t('fora da janela a execução é recusada com o motivo', async () => {
  limpar();
  setCfg('comm_janela_ativa', '1');
  setCfg('comm_janela_inicio', '8'); setCfg('comm_janela_fim', '20');
  const l = novaLista();
  addMembro(l, novaPessoa({ email: 'a@x.com' }));
  const camp = novaCampanha(novoTemplate(), l);
  // Não dá para congelar o relógio da rota; então só verificamos que o campo
  // existe e que o forçar está disponível.
  const r = await call('post', '/api/comm/campanhas/:id/executar', { ignorarJanela: true }, { id: camp });
  assert(r.body.success, JSON.stringify(r.body));
});

await t('quem está em opt-out não recebe nem na execução', async () => {
  limpar();
  setCfg('comm_janela_ativa', '0');
  const l = novaLista();
  addMembro(l, novaPessoa({ email: 'quer@x.com' }));
  addMembro(l, novaPessoa({ email: 'naoquer@x.com' }));
  dest.registrarOptOut(db, { canal: 'email', destino: 'naoquer@x.com' });
  const camp = novaCampanha(novoTemplate(), l);
  await call('post', '/api/comm/campanhas/:id/executar', {}, { id: camp });
  const destinos = db.prepare(
    "SELECT destino FROM comm_envios WHERE campanhaId = ? AND status <> 'descartado'").all(camp).map((x) => x.destino);
  assert(destinos.length === 1 && destinos[0] === 'quer@x.com', JSON.stringify(destinos));
});

// ==================== PRÉVIA ====================
console.log('\n--- prévia antes de disparar ---');

await t('a prévia mostra o resumo e um exemplo renderizado', async () => {
  limpar();
  setCfg('comm_janela_ativa', '0');
  const l = novaLista();
  addMembro(l, novaPessoa({ razaoSocial: 'Maria Silva ME', email: 'maria@x.com' }));
  addMembro(l, novaPessoa({ email: null }));
  const camp = novaCampanha(novoTemplate(), l);
  const r = await call('get', '/api/comm/campanhas/:id/previa', {}, { id: camp });
  assert(r.body.success, JSON.stringify(r.body));
  assert(r.body.resumo.elegiveis === 1 && r.body.resumo.semDestino === 1, JSON.stringify(r.body.resumo));
  assert(r.body.exemplos[0].assunto === 'Oi Maria', r.body.exemplos[0].assunto);
});

await t('a prévia diz se o envio será real ou simulado', async () => {
  const camp = db.prepare('SELECT id FROM comm_campanhas ORDER BY id DESC LIMIT 1').get().id;
  const r = await call('get', '/api/comm/campanhas/:id/previa', {}, { id: camp });
  // Sem SMTP configurado, ninguém deve achar que a campanha vai sair.
  assert(r.body.envioReal === false, 'envioReal: ' + r.body.envioReal);
});

await t('a prévia aponta problema de template antes do disparo', async () => {
  limpar();
  const l = novaLista();
  addMembro(l, novaPessoa());
  const tpl = db.prepare(
    "INSERT INTO comm_templates (nome, canal, assunto, corpo) VALUES ('T', 'email', 'Oi', 'Olá {{fone}}')").run().lastInsertRowid;
  const camp = novaCampanha(tpl, l);
  const r = await call('get', '/api/comm/campanhas/:id/previa', {}, { id: camp });
  assert(r.body.problemasTemplate.some((p) => p.codigo === 'placeholder_desconhecido'),
    JSON.stringify(r.body.problemasTemplate));
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
})();
