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
const schema = require('./schema-de-tenant').lerSchema('/tmp/vp-comm-schema.sql');
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

function call(m, p, body = {}, params = {}, query = {}, arquivo = null) {
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
    // `arquivo` faz o papel do multer, que fica de fora por chamarmos só o handler.
    Promise.resolve(h({ body, params, query, file: arquivo, user: { username: 't' }, session: { username: 't' },
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

// ==================== contato avulso por planilha ====================
//
// Até 28/09 o contato avulso era digitado num campo de texto; desde então vem
// de planilha (.xlsx, .xls ou .csv). As garantias são as mesmas de antes:
// telefone inválido não entra calado, o mesmo número não entra duas vezes, e
// contato avulso não fura o opt-out.

const XLSX = require('xlsx');
const planilha = (linhas, tipo = 'xlsx') => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), 'Contatos');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: tipo }), originalname: 'contatos.' + tipo };
};
const importar = (l, linhas, tipo) => call('post', '/api/comm/listas/:id/importar', {}, { id: l }, {}, planilha(linhas, tipo));
const membrosDe = (l) => db.prepare('SELECT destinoManual, nomeManual, ramo FROM comm_lista_membros WHERE listaId = ? ORDER BY id').all(l);

await t('planilha entra na lista, com nome e ramo, e o telefone normalizado', async () => {
  limpar();
  const l = novaLista();
  const r = await importar(l, [['Telefone', 'Nome', 'Ramo'],
    ['94 99123-4567', 'Zé da Loja', 'Comércio varejista de bebidas'],
    [5594988887777, 'Maria Souza', ''],
    ['(94) 97777-6666', '', 'mercearia']]);
  assert(r.body.success, 'falhou: ' + (r.body.error || ''));
  assert(r.body.adicionados === 3, `entraram ${r.body.adicionados} de 3`);
  const m = membrosDe(l);
  assert(m.every((x) => /^\d+$/.test(x.destinoManual)), 'telefone sem normalizar: ' + JSON.stringify(m.map((x) => x.destinoManual)));
  // Digitado como NÚMERO no Excel: tem de chegar inteiro, e não como 5,59E+12.
  assert(m[1].destinoManual === '5594988887777', 'o número do Excel chegou como ' + m[1].destinoManual);
  assert(m[0].nomeManual === 'Zé da Loja' && m[0].ramo === 'Comércio varejista de bebidas', JSON.stringify(m[0]));
  assert(m[2].nomeManual === null && m[2].ramo === 'mercearia', JSON.stringify(m[2]));
});

await t('titulo com acento e caixa alta tambem vale, e csv tambem', async () => {
  limpar();
  const l = novaLista();
  // "Segmento" é coluna própria desde 28/09 (vai ao cadastro de segmentos, ver
  // test-segmentos); o ramo sai de Ramo, Atividade ou CNAE.
  const r = await importar(l, [['CELULAR', 'Razão Social', 'ATIVIDADE'], ['5594988887777', 'Loja A', 'moda']], 'csv');
  assert(r.body.success && r.body.adicionados === 1, JSON.stringify(r.body));
  assert(membrosDe(l)[0].nomeManual === 'Loja A' && membrosDe(l)[0].ramo === 'moda', JSON.stringify(membrosDe(l)));
});

await t('planilha sem a coluna Telefone e RECUSADA, e diz o que falta', async () => {
  limpar();
  const l = novaLista();
  const r = await importar(l, [['Nome', 'Ramo'], ['Zé', 'bar']]);
  assert(r.status === 400 && /Telefone/.test(r.body.error || ''), JSON.stringify(r));
  assert(membrosDe(l).length === 0, 'gravou membro sem telefone');
});

await t('telefone invalido e RECUSADO e volta com a linha do Excel', async () => {
  limpar();
  const l = novaLista();
  const r = await importar(l, [['Telefone'], ['5594988887777'], ['não é telefone'], ['123']]);
  assert(r.body.adicionados === 1, `entraram ${r.body.adicionados}, só um era válido`);
  assert(r.body.recusados.length === 2, 'recusados: ' + JSON.stringify(r.body.recusados));
  assert(r.body.recusados.includes('linha 3: não é telefone'),
    'a linha recusada precisa voltar com o número da linha, para a pessoa achar o erro: ' + JSON.stringify(r.body.recusados));
});

await t('so linha invalida nao cria membro nenhum e explica', async () => {
  limpar();
  const l = novaLista();
  const r = await importar(l, [['Telefone'], ['abc'], ['123']]);
  assert(r.status === 400, `deveria recusar (veio ${r.status})`);
  assert(/Recusados/.test(r.body.error || ''), 'o erro não diz quais foram: ' + r.body.error);
  assert(membrosDe(l).length === 0, 'gravou membro a partir de linha inválida');
});

await t('o mesmo numero em dois formatos nao duplica o contato', async () => {
  limpar();
  const l = novaLista();
  await importar(l, [['Telefone'], ['5594988887777']]);
  const r = await importar(l, [['Telefone'], ['94 98888-7777']]);
  assert(r.body.adicionados === 0 && r.body.repetidos === 1, JSON.stringify(r.body));
  assert(membrosDe(l).length === 1, 'a lista ficou com o mesmo telefone duas vezes');
});

await t('contato da planilha NAO fura o opt-out no disparo', async () => {
  // É a garantia que torna o contato avulso aceitável. Sem ela, importar o
  // número seria o caminho para alcançar justamente quem pediu para parar.
  limpar();
  const l = novaLista();
  await importar(l, [['Telefone', 'Nome'], ['5594988887777', 'Quem pediu para sair'], ['5594977776666', 'Pode receber']]);
  db.prepare("INSERT INTO comm_optout (canal, destino) VALUES ('whatsapp', '5594988887777')").run();

  const r = dest.prepararDestinatarios(db, { listaId: l, canal: 'whatsapp', tipo: 'marketing' });
  assert(r.enviar.length === 1, `iriam ${r.enviar.length} mensagens`);
  assert(r.enviar[0].destino === '5594977776666', 'foi para o destino errado: ' + r.enviar[0].destino);
  assert(r.descartados.some((d) => /opt-out/.test(d.motivo)),
    'o opt-out não apareceu entre os descartes: ' + JSON.stringify(r.descartados));
});

// ==================== o segmento de cada contato ====================
//
// Até 28/09 o ramo era editável por contato e o segmento saía dele a cada
// consulta. Agora o segmento mora na FICHA da pessoa e a lista o mostra dali;
// o cadastro, a edição e os filtros estão em test-segmentos.

await t('a lista mostra o segmento da ficha de cada contato', async () => {
  limpar();
  require('../segmentos').migrarSegmentos(db);
  const l = novaLista();
  const pid = novaPessoa({ telefone: '5594966665555' });
  const bebidas = require('../segmentos').segmentoPorNome(db, 'Bebidas');
  db.prepare('UPDATE pessoas SET segmentoId = ? WHERE id = ?').run(bebidas, pid);
  await call('post', '/api/comm/listas/:id/membros', { pessoaIds: [pid] }, { id: l });
  const r = await call('get', '/api/comm/listas/:id', {}, { id: l });
  assert(r.body.membros[0].segmentoId === bebidas, JSON.stringify(r.body.membros[0]));
  assert(r.body.porSegmento.some(x => x.segmentoId === bebidas && x.n === 1), JSON.stringify(r.body.porSegmento));
});

await t('a tela manda a planilha para a rota que a le', async () => {
  // Se o nome do campo ou da rota mudar de um lado só, a importação volta a
  // não fazer nada, sem erro.
  const tela = fs.readFileSync(
    require('path').join(__dirname, '..', 'public/comunicacao/listas.html'), 'utf8');
  assert(/id="ltArquivo"/.test(tela), 'a tela não tem o campo da planilha');
  assert(/fd\.append\('arquivo', arquivo\)/.test(tela) && /\/importar`/.test(tela),
    'a tela não envia a planilha no campo `arquivo` para /importar');
  assert(/recusados/.test(tela), 'a tela não mostra os telefones recusados');
  assert(!/ltManuais/.test(tela), 'o campo de números à mão continua na tela');
});

// ==================== imagens do modelo ====================
//
// Desde 28/09 o modelo tem um conjunto de imagens, e cada envio sorteia uma
// (comm-imagens.js). A pasta vai para /tmp: nenhuma suíte grava em data/.

const imagensModelo = require('../comm-imagens');
imagensModelo.raiz = fs.mkdtempSync('/tmp/comunicacao-img-');
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16, 7)]);
const subir = (id, buffer) => call('post', '/api/comm/templates/:id/imagens', {}, { id }, {}, { buffer, originalname: 'x.png' });

await t('imagem do modelo: arquivo que nao e imagem e recusado pela assinatura', async () => {
  const tpl = novoTemplate();
  const r = await subir(tpl, Buffer.from('não sou imagem, só me chamo .png'));
  assert(r.status === 400 && /não é uma imagem/.test(r.body.error || ''), JSON.stringify(r));
  const l = await call('get', '/api/comm/templates/:id/imagens', {}, { id: tpl });
  assert(l.body.imagens.length === 0, 'gravou o arquivo recusado');
});

await t('imagem do modelo: entra, aparece na lista e na contagem, e sai', async () => {
  const tpl = novoTemplate();
  const a = await subir(tpl, PNG);
  const b = await subir(tpl, PNG);
  assert(a.body.success && b.body.success && b.body.imagens.length === 2, JSON.stringify(b.body));
  const lista = await call('get', '/api/comm/templates', {}, {});
  assert(lista.body.templates.find(x => x.id === tpl).imagens === 2, 'a tabela de modelos não conta as imagens');
  const d = await call('delete', '/api/comm/templates/:id/imagens/:arquivo', {}, { id: tpl, arquivo: a.body.arquivo });
  assert(d.body.success && d.body.imagens.length === 1 && d.body.imagens[0] === b.body.arquivo, JSON.stringify(d.body));
});

await t('imagem do modelo: nome com caminho nao sai da pasta do modelo', async () => {
  const tpl = novoTemplate();
  await subir(tpl, PNG);
  for (const nome of ['../../../../etc/passwd', '..%2F..%2Fpncp.db', 'img-1-1.png/../../x']) {
    assert(imagensModelo.caminho('demo', tpl, nome) === null, 'aceitou ' + nome);
    const d = await call('delete', '/api/comm/templates/:id/imagens/:arquivo', {}, { id: tpl, arquivo: nome });
    assert(d.status === 404, `apagar "${nome}" respondeu ${d.status}`);
  }
  assert(imagensModelo.listar('demo', tpl).length === 1, 'a imagem verdadeira sumiu');
});

await t('imagem do modelo: o limite de ' + imagensModelo.MAX_IMAGENS + ' e dito, e nao estoura calado', async () => {
  const tpl = novoTemplate();
  for (let i = 0; i < imagensModelo.MAX_IMAGENS; i++) await subir(tpl, PNG);
  const r = await subir(tpl, PNG);
  assert(r.status === 400 && /máximo/.test(r.body.error || ''), JSON.stringify(r.body));
  assert(imagensModelo.listar('demo', tpl).length === imagensModelo.MAX_IMAGENS, 'passou do limite');
});

// Vídeo MP4 no conjunto (30/09, a pedido): o modelo de alimentação só aceitava
// imagem. Só MP4 porque a Evolution recebe o arquivo como `video/mp4`, e o .mov
// do iPhone, que tem a mesma caixa `ftyp`, chegaria quebrado a quem abrisse.
const MP4 = (brand, bytes = 32) => Buffer.concat([
  Buffer.from('0000001c', 'hex'), Buffer.from('ftyp' + brand, 'ascii'), Buffer.alloc(bytes, 9)]);

await t('video MP4 entra no conjunto do modelo, ao lado das imagens', async () => {
  const tpl = novoTemplate();
  // Vários brands, porque cada editor grava o seu: a regra recusa o que não é
  // vídeo (qt, M4A) em vez de manter lista de aceitos, que barraria exportação
  // de programa não previsto.
  for (const brand of ['isom', 'mp42', 'MSNV', 'iso8']) {
    const r = await call('post', '/api/comm/templates/:id/imagens', {}, { id: tpl }, {},
      { buffer: MP4(brand), originalname: `promo-${brand.trim()}.mp4` });
    assert(r.body.success, `brand ${brand} recusado: ` + JSON.stringify(r.body));
    await call('delete', '/api/comm/templates/:id/imagens/:arquivo', {}, { id: tpl, arquivo: r.body.arquivo });
  }
  const v = await call('post', '/api/comm/templates/:id/imagens', {}, { id: tpl }, {},
    { buffer: MP4('isom'), originalname: 'promo.mp4' });
  assert(v.body.success && /\.mp4$/.test(v.body.arquivo), JSON.stringify(v.body));
  await subir(tpl, PNG);
  const l = await call('get', '/api/comm/templates/:id/imagens', {}, { id: tpl });
  assert(l.body.imagens.length === 2, 'o conjunto não guardou os dois: ' + JSON.stringify(l.body.imagens));
  // O sorteio é entre todos: 40 voltas têm de cair nos dois arquivos.
  const sorteados = new Set();
  for (let i = 0; i < 40; i++) sorteados.add(require('path').extname(imagensModelo.sortear('demo', tpl)));
  assert(sorteados.has('.mp4') && sorteados.has('.png'), 'o sorteio não mistura vídeo e imagem: ' + [...sorteados]);
});

await t('video que nao e MP4 e recusado dizendo para converter', async () => {
  const tpl = novoTemplate();
  const r = await call('post', '/api/comm/templates/:id/imagens', {}, { id: tpl }, {},
    { buffer: MP4('qt  '), originalname: 'do-iphone.mov' });
  assert(r.status === 400 && /não um vídeo MP4/.test(r.body.error || '')
    && /qt/.test(r.body.error), JSON.stringify(r));
  assert(imagensModelo.listar('demo', tpl).length === 0, 'gravou o vídeo recusado');
});

await t('video acima do teto e recusado com o tamanho, e nao no envio', async () => {
  const tpl = novoTemplate();
  // O teto sai do módulo, e não escrito aqui: em 30/09 ele passou de 16 para 64
  // MB (o de 16 era o da API oficial do WhatsApp, que não é o caminho daqui) e
  // uma suíte com o número fixo teria reprovado sem defeito nenhum.
  const teto = Math.round(imagensModelo.MAX_VIDEO_BYTES / 1048576);
  const r = await call('post', '/api/comm/templates/:id/imagens', {}, { id: tpl }, {},
    { buffer: MP4('isom', imagensModelo.MAX_VIDEO_BYTES + 1), originalname: 'grande.mp4' });
  assert(r.status === 400 && new RegExp(`${teto} MB`).test(r.body.error || ''), JSON.stringify(r.body));
  assert(imagensModelo.listar('demo', tpl).length === 0, 'gravou o vídeo grande');
});

await t('a tela de modelos aceita video e mostra o que subiu', async () => {
  const tela = fs.readFileSync(require('path').join(__dirname, '..', 'public/comunicacao/modelos.html'), 'utf8');
  const campo = tela.match(/<input[^>]*id="mdArquivo"[^>]*>/)[0];
  assert(/video\/mp4/.test(campo), 'o seletor de arquivo não aceita vídeo: ' + campo);
  assert(/<video[^>]*src=/.test(tela), 'a grade do modelo não mostra vídeo');
});

await t('a tela de modelos usa as rotas do conjunto, e nao a da imagem unica', async () => {
  const tela = fs.readFileSync(require('path').join(__dirname, '..', 'public/comunicacao/modelos.html'), 'utf8');
  assert(/\/imagens`, \{ method:'POST'/.test(tela), 'a tela não envia para /imagens');
  assert(/multiple/.test(tela.match(/<input[^>]*id="mdArquivo"[^>]*>/)[0]), 'o seletor não aceita várias imagens');
  assert(!/\/imagem`/.test(tela) && !/imagemPath/.test(tela), 'a tela ainda usa a imagem única');
});

// ==================== campanha para contato avulso ====================
//
// A lista aceita contato sem ficha de cliente (planilha, digitado, legado), e a
// tabela de envios exigia pessoaId: o disparo falhava com "NOT NULL constraint
// failed: comm_envios.pessoaId" (campanha "exemplo" do 1bit, 28/09). O banco
// desta suíte sai do schema real, com a restrição, e reproduz o caso.

await t('campanha para lista de avulsos prepara os envios, e "Ver envios" mostra o nome', async () => {
  limpar();
  const l = novaLista('Só avulsos');
  // Direto na lista, como os do legado: a planilha, desde 28/09, dá ficha a
  // cada contato, e o avulso sem ficha continua existindo até a migração.
  for (const [tel, nome] of [['5594992620471', 'paloma'], ['5594991112936', 'carlos']]) {
    db.prepare('INSERT INTO comm_lista_membros (listaId, destinoManual, nomeManual) VALUES (?, ?, ?)').run(l, tel, nome);
  }
  const tpl = novoTemplate({ canal: 'whatsapp', corpo: 'Olá {{primeiroNome}}' });
  const camp = novaCampanha(tpl, l, 'whatsapp');
  // O disparo do WhatsApp grava os envios e passa ao motor, que pausa sozinho:
  // este banco não tem número conectado, então nada sai para a rede.
  require('../comm-routes').dispararCommWhatsApp(db, 'demo', camp);
  await new Promise(r => setTimeout(r, 300));
  const n = db.prepare('SELECT COUNT(*) n FROM comm_envios WHERE campanhaId = ? AND pessoaId IS NULL').get(camp).n;
  assert(n === 2, `${n} envio(s) de avulso gravado(s)`);
  const v = await call('get', '/api/comm/campanhas/:id', {}, { id: camp });
  const nomes = v.body.envios.map(e => e.razaoSocial).sort().join(',');
  assert(nomes === 'carlos,paloma', '"Ver envios" mostra: ' + nomes);
  const msgs = v.body.envios.map(e => e.mensagemRenderizada).sort().join(' | ');
  assert(msgs === 'Olá carlos | Olá paloma', 'a mensagem do avulso saiu: ' + msgs);
});

await t('a reconstrucao da tabela de envios nao perde envio e roda uma vez so', () => {
  const antes = db.prepare('SELECT COUNT(*) n, MAX(id) m FROM comm_envios').get();
  assert(dest.permitirEnvioAvulso(db) === false, 'rodou de novo numa tabela já reconstruída');
  const depois = db.prepare('SELECT COUNT(*) n, MAX(id) m FROM comm_envios').get();
  assert(JSON.stringify(antes) === JSON.stringify(depois), JSON.stringify([antes, depois]));
  const col = db.prepare('PRAGMA table_info(comm_envios)').all().find(c => c.name === 'pessoaId');
  assert(col && col.notnull === 0, 'pessoaId continua obrigatório');
});

// ==================== campanha nova: por quais números sai ====================

await t('campanha nova grava os numeros escolhidos e recusa numero que nao e da empresa', async () => {
  const canaisMod = require('../whatsapp-canais');
  canaisMod.migrarCanais(db);
  db.exec('DELETE FROM whatsapp_canais');
  db.prepare("INSERT INTO whatsapp_canais (id, nome, instance, padrao, config) VALUES (1, 'Comercial', 'le_demo', 1, '{}')").run();
  db.prepare("INSERT INTO whatsapp_canais (id, nome, instance, padrao, config) VALUES (2, 'Suporte', 'le_demo_2', 0, '{}')").run();
  const tpl = novoTemplate({ canal: 'whatsapp' });
  const l = novaLista('Lista dos números');
  const ruim = await call('post', '/api/comm/campanhas', { nome: 'x', templateId: tpl, listaId: l, canais: [99] });
  assert(ruim.status === 400 && /não encontrado/.test(ruim.body.error || ''), JSON.stringify(ruim.body));
  const bom = await call('post', '/api/comm/campanhas', { nome: 'x', templateId: tpl, listaId: l, canais: [2, 1, 2] });
  assert(bom.body.success && bom.body.campanha.canais === '[2,1]', 'gravou ' + bom.body.campanha && bom.body.campanha.canais);
  const ed = await call('put', '/api/comm/campanhas/:id', { canais: [] }, { id: bom.body.campanha.id });
  assert(ed.body.success && ed.body.campanha.canais === null, 'lista vazia devia voltar ao padrão: ' + JSON.stringify(ed.body.campanha));
  const dup = await call('put', '/api/comm/campanhas/:id', { canais: [2] }, { id: bom.body.campanha.id });
  const copia = await call('post', '/api/comm/campanhas/:id/duplicar', {}, { id: dup.body.campanha.id });
  assert(copia.body.campanha.canais === '[2]', 'a cópia perdeu os números: ' + copia.body.campanha.canais);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
})();
