/**
 * comm-routes.js — Comunicação em massa (templates, listas, campanhas).
 *
 * Modelo:
 *   comm_templates    — template de mensagem (canal email|whatsapp, com placeholders)
 *   comm_listas       — listas de destinatários
 *   comm_lista_membros — pessoas em cada lista
 *   comm_campanhas    — uma execução de template em uma lista
 *   comm_envios       — uma linha por destinatário (status individual)
 *
 * Placeholders suportados: os de comm-destinos.VARIAVEIS ({{primeiroNome}}, {{cidade}}, {{ramo}}…)
 *
 * Elegibilidade e opt-out ficam em comm-destinos.js: destino é normalizado,
 * validado, deduplicado e checado contra o descadastro ANTES de virar envio.
 *
 * E-mail sai de verdade quando há SMTP configurado. Sem SMTP a campanha fica em
 * 'simulada' e NÃO se declara enviada — antes ela marcava 'enviada' com N
 * 'enviados' para mensagens que nunca saíram do servidor.
 */

const { logAction } = require('./audit-log');
const { reentrarContextoTenant } = require('./tenant-middleware');
const { enviarWhatsApp, loadProviderConfig, enviarWhatsAppMidia, checarRitmo } = require('./whatsapp-adapter');
const canais = require('./whatsapp-canais');
const { localDate } = require('./wa-m1-utils');
const dest = require('./comm-destinos');
const segmentos = require('./segmentos');
const leadFicha = require('./lead-ficha');
const numerosWa = require('./wa-numeros');
const { dentroDoExpediente } = require('./atendimento-horario');
const imagensModelo = require('./comm-imagens');
const multer = require('multer');
// Folga sobre o teto do vídeo (comm-imagens.MAX_VIDEO_BYTES, 64 MB), para quem
// passa dele receber o tamanho em MB e não a recusa seca do multer. Com os 8 MB
// de antes, um vídeo de campanha morria aqui sem mensagem que se entendesse.
const uploadImagem = multer({ storage: multer.memoryStorage(),
  limits: { fileSize: require('./comm-imagens').MAX_VIDEO_BYTES + 4 * 1024 * 1024 } });
const uploadPlanilha = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const { loadSmtpConfig, enviarEmailSimples } = require('./email-client');

// ==================== planilha de contatos da lista ====================
//
// Desde 28/09 o contato avulso entra na lista por planilha (.xlsx, .xls ou
// .csv), e não mais digitado num campo de texto. A primeira linha traz os
// títulos: Telefone é obrigatória; Nome, Segmento e Ramo, opcionais. O título
// casa pelo começo da palavra, sem acento e sem caixa, para "Celular" e "Razão
// social" servirem também.
const TITULOS_PLANILHA = {
  telefone: /^(telefone|celular|whatsapp|fone|numero)/,
  nome: /^(nome|razao|empresa|contato|cliente)/,
  segmento: /^segmento/,
  ramo: /^(ramo|atividade|cnae)/,
};
const MAX_LINHAS_PLANILHA = 20000;

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

/** As linhas da planilha como { telefone, nome, segmento, ramo, rotulo }, ou erro dito. */
function lerPlanilhaDeContatos(buffer) {
  const XLSX = require('xlsx');
  let aoa;
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const folha = wb.Sheets[wb.SheetNames[0]];
    // raw: o telefone digitado como número vem inteiro (5594991234567), e não
    // no formato de exibição do Excel, que o viraria 5,59E+12.
    aoa = folha ? XLSX.utils.sheet_to_json(folha, { header: 1, defval: '', raw: true, blankrows: false }) : [];
  } catch (_) {
    throw new Error('Não consegui ler o arquivo. Envie uma planilha .xlsx, .xls ou .csv');
  }
  if (!aoa.length) throw new Error('A planilha está vazia');
  const coluna = {};
  aoa[0].forEach((titulo, i) => {
    const t = semAcento(titulo);
    for (const [campo, re] of Object.entries(TITULOS_PLANILHA)) {
      if (coluna[campo] == null && re.test(t)) coluna[campo] = i;
    }
  });
  if (coluna.telefone == null) {
    throw new Error('A primeira linha precisa ter o título Telefone. Nome, Segmento e Ramo são opcionais');
  }
  const linhas = aoa.slice(1).filter(r => r.some(c => String(c).trim() !== ''));
  if (linhas.length > MAX_LINHAS_PLANILHA) {
    throw new Error(`A planilha tem ${linhas.length} linhas; o máximo por envio é ${MAX_LINHAS_PLANILHA}`);
  }
  const cel = (r, campo) => (coluna[campo] == null ? '' : String(r[coluna[campo]] ?? '').trim());
  return linhas.map((r, i) => ({
    telefone: cel(r, 'telefone'), nome: cel(r, 'nome') || null,
    segmento: cel(r, 'segmento') || null, ramo: cel(r, 'ramo') || null,
    // Linha como a pessoa vê no Excel: a 1 é a dos títulos.
    rotulo: `linha ${i + 2}: ${cel(r, 'telefone') || '(sem telefone)'}`,
  }));
}

/**
 * Grava os contatos da planilha na lista, cada um com a sua ficha
 * (lead-ficha.js): a de lead que já existe com o mesmo telefone, ou uma nova.
 * O segmento sai da coluna Segmento, pelo nome do cadastro; sem ela, ou com um
 * nome que não existe, sai do Ramo pelo cálculo de palavras, e no fim o
 * Genérico. O telefone é normalizado como todo destino de WhatsApp, então o
 * mesmo número escrito de dois jeitos entra uma vez só; a linha sem telefone
 * válido volta nomeada para a pessoa achar o erro. Quem pediu para sair entra
 * na lista e é descartado no envio, como qualquer outro.
 */
function adicionarContatos(db, lista, linhas) {
  const validos = [], recusados = [];
  for (const l of linhas) {
    const destino = dest.normalizarDestino('whatsapp', l.telefone);
    if (destino) validos.push({ ...l, destino }); else recusados.push(l.rotulo);
  }
  const indice = leadFicha.indiceDeTelefones(db);
  const fonte = `Importação da lista ${lista.nome}`;
  const stmt = db.prepare(`INSERT OR IGNORE INTO comm_lista_membros (listaId, pessoaId, destinoManual, nomeManual, ramo)
    VALUES (?, ?, ?, ?, ?)`);
  let adicionados = 0, fichasNovas = 0;
  const desconhecidos = new Set();
  db.transaction(() => {
    for (const v of validos) {
      let segmentoId = v.segmento ? segmentos.segmentoPorNome(db, v.segmento) : null;
      if (v.segmento && !segmentoId) desconhecidos.add(v.segmento);
      if (!segmentoId) segmentoId = segmentos.segmentoDoRamo(db, v.ramo);
      const f = leadFicha.fichaDoContato(db, indice, { destino: v.destino, nome: v.nome, segmentoId, fonte });
      if (f.criada) fichasNovas++;
      if (stmt.run(lista.id, f.pessoaId, v.destino, v.nome, v.ramo).changes) adicionados++;
    }
  })();
  return { lidos: linhas.length, adicionados, repetidos: validos.length - adicionados, fichasNovas,
    recusados, segmentosDesconhecidos: [...desconhecidos] };
}

/**
 * O texto de um envio, montado na hora de enviar com o modelo como ele está
 * AGORA. Até 29/09 o texto era montado ao preparar a lista e ficava congelado:
 * editar o modelo com a campanha pausada não mudava nada para os que faltavam
 * (campanha 3 do 1bit). O texto que sai é gravado no envio, e o registro do que
 * cada um recebeu continua certo. Sem modelo (apagado), fica o que foi preparado.
 */
function textoDoEnvio(tdb, camp, e) {
  const tpl = tdb.prepare('SELECT corpo, assunto FROM comm_templates WHERE id = ?').get(camp.templateId);
  if (!tpl) return { corpo: e.mensagemRenderizada, assunto: e.assuntoRenderizado };
  let pessoa = e.pessoaId ? tdb.prepare('SELECT * FROM pessoas WHERE id = ?').get(e.pessoaId) : null;
  if (!pessoa) {
    const m = tdb.prepare('SELECT nomeManual FROM comm_lista_membros WHERE listaId = ? AND destinoManual = ?').get(camp.listaId, e.destino);
    pessoa = { razaoSocial: (m && m.nomeManual) || e.destino, telefone: e.destino };
  }
  return { corpo: renderizar(tpl.corpo, pessoa), assunto: tpl.assunto ? renderizar(tpl.assunto, pessoa) : null };
}

/**
 * Ritmo e horário da campanha nova (29/09). Até então ela não tinha tela para
 * isso: 30 envios por dia por número e 45 a 120 s entre envios, fixos no
 * banco, e a janela de 8h às 20h conferida só no clique em "Enviar". Uma
 * campanha começada às 19h55 seguia mandando de madrugada.
 *
 * Campo em branco vale o padrão de antes: `whatsapp_daily_limit` (30),
 * `whatsapp_throttle_min/max` (45 e 120) e a janela `comm_janela_*` (8h às
 * 20h), agora conferida a cada envio. O limite por dia é da CAMPANHA. O teto
 * do número, na tela Canal, continua valendo por cima: o mais restritivo ganha.
 */
function ritmoDaCampanha(tdb, camp) {
  let r = {};
  try { r = JSON.parse((camp && camp.ritmo) || '{}') || {}; } catch (_) { /* ilegível: vale o padrão */ }
  const cfg = (k) => { try { const x = tdb.prepare('SELECT valor FROM config WHERE chave = ?').get(k); return x ? x.valor : null; } catch (_) { return null; } };
  const num = (v, padrao) => (v === '' || v == null || !Number.isFinite(Number(v)) ? padrao : Number(v));
  const limiteDia = Math.max(1, num(r.limiteDia, num(cfg('whatsapp_daily_limit'), 30)) || 30);
  let min = Math.max(0, num(r.intervaloMin, num(cfg('whatsapp_throttle_min'), 45)));
  let max = Math.max(0, num(r.intervaloMax, num(cfg('whatsapp_throttle_max'), 120)));
  if (max < min) [min, max] = [max, min];
  let h = r.horario || null;
  if (!h && String(cfg('comm_janela_ativa') ?? '1') === '1') {
    const hh = (v, p) => String(num(v, p)).padStart(2, '0') + ':00';
    h = { inicio: hh(cfg('comm_janela_inicio'), 8), fim: hh(cfg('comm_janela_fim'), 20),
          dias: String(cfg('comm_janela_dias_uteis')) === '1' ? ['seg', 'ter', 'qua', 'qui', 'sex'] : undefined };
  }
  const horario = h ? require('./wa-campaigns-routes').horarioDaCampanha(h) : null;
  return { limiteDia, min, max, horario: horario && !horario.erro ? horario : null };
}

/** O ritmo que veio da tela, conferido: JSON para gravar, ou null (tudo padrão). Lança com o motivo. */
function validarRitmo(bruto) {
  if (bruto == null) return null;
  if (typeof bruto !== 'object') throw new Error('Ritmo inválido');
  const inteiro = (v, de, ate, nome) => {
    if (v === '' || v == null) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < de || n > ate) throw new Error(`${nome}: use um número inteiro de ${de} a ${ate}`);
    return n;
  };
  const r = {
    limiteDia: inteiro(bruto.limiteDia, 1, 2000, 'Limite por dia'),
    intervaloMin: inteiro(bruto.intervaloMin, 0, 3600, 'Intervalo mínimo'),
    intervaloMax: inteiro(bruto.intervaloMax, 0, 3600, 'Intervalo máximo'),
  };
  if (bruto.horario) {
    const h = require('./wa-campaigns-routes').horarioDaCampanha(bruto.horario);
    if (h.erro) throw new Error(h.erro);
    r.horario = { inicio: h.inicio, fim: h.fim, dias: h.dias };
  }
  const limpo = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined));
  return Object.keys(limpo).length ? JSON.stringify(limpo) : null;
}

/** Quantos da lista a campanha alcança, antes do descarte: todos, ou só os dos segmentos. */
function publicoDaLista(db, listaId, ids) {
  if (!ids.length) return db.prepare('SELECT COUNT(*) AS n FROM comm_lista_membros WHERE listaId = ?').get(listaId).n;
  return db.prepare(`SELECT COUNT(*) AS n FROM comm_lista_membros m JOIN pessoas p ON p.id = m.pessoaId
    WHERE m.listaId = ? AND p.segmentoId IN (${ids.map(() => '?').join(',')})`).get(listaId, ...ids).n;
}

// Campanhas WhatsApp do comm em execução neste processo: key `comm:${slug}:${id}`.
const running = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Runner de envio REAL do canal WhatsApp (roda fora do request; db REAL do tenant).
async function runCommWhatsApp(tdb, slug, campId) {
  const key = 'comm:' + slug + ':' + campId;
  if (running.has(key)) return;
  const ctl = { cancelled: false };
  running.set(key, ctl);
  try {
    try { tdb.exec("ALTER TABLE comm_envios ADD COLUMN dia TEXT"); } catch (_) {}
    try { tdb.exec("ALTER TABLE comm_envios ADD COLUMN canalId INTEGER"); } catch (_) {}
    try { tdb.exec("ALTER TABLE comm_campanhas ADD COLUMN canais TEXT"); } catch (_) {}
    dest.migrarRodadas(tdb);   // as consultas abaixo são da rodada atual (e a coluna ritmo)
    tdb.exec("CREATE TABLE IF NOT EXISTS wa_optout (telefone TEXT PRIMARY KEY, criado_em TEXT DEFAULT CURRENT_TIMESTAMP)");
    // As imagens do modelo: uma sorteada a cada envio (comm-imagens.js).
    let modeloId = null, escolhidos = null, rodada = 1, campAtual = null;
    try {
      const c = tdb.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(campId);
      campAtual = c;
      modeloId = c?.templateId || null;
      escolhidos = c?.canais ? JSON.parse(c.canais) : null;
      rodada = c?.rodada || 1;
    } catch (_) { /* tenant sem a tabela */ }
    // Limite por dia, intervalo e horário da campanha (ritmoDaCampanha).
    const ritmo = ritmoDaCampanha(tdb, campAtual);
    // Os números da campanha; com mais de um, os envios se revezam entre eles.
    const { numeros, erro: semNumero } = canais.numerosDaCampanha(tdb, escolhidos);
    if (semNumero) {
      tdb.prepare("UPDATE comm_campanhas SET status = 'pausada', observacoes = ? WHERE id = ?").run(semNumero, campId);
      return;
    }
    let vez = 0;

    // Espera em pedaços de 1 s, para pausar e cancelar valerem durante ela.
    const esperar = async (s) => { for (let i = 0; i < Math.max(s, 1) && !ctl.cancelled; i++) await sleep(1000); };
    while (!ctl.cancelled) {
      const hoje = localDate(Date.now(), 'America/Belem');
      // Fora do horário da campanha, ou com o limite do dia dela cumprido, o
      // laço espera e confere de minuto em minuto. Continua sozinho quando o
      // horário abre ou o dia vira, sem ninguém retomar.
      // Quem sobrou da rodada vem ANTES de qualquer espera: sem ninguém na fila
      // não há o que aguardar, e esperar horário, limite do dia ou intervalo do
      // número para enviar o que não existe prendia o laço (e a campanha em
      // 'enviando') até o horário abrir, o que podia ser na manhã seguinte.
      const e = tdb.prepare(`
        SELECT * FROM comm_envios
        WHERE campanhaId = ? AND rodada = ? AND status = 'pendente' AND destino IS NOT NULL
          AND destino NOT IN (SELECT destino FROM comm_optout WHERE canal = 'whatsapp')
        LIMIT 1
      `).get(campId, rodada);
      if (!e) break;
      if (ritmo.horario && !dentroDoExpediente(ritmo.horario.faixas, new Date())) { await esperar(60); continue; }
      const hojeNaCampanha = tdb.prepare(`SELECT COUNT(*) AS n FROM comm_envios
        WHERE campanhaId = ? AND status = 'enviado' AND dia = ?`).get(campId, hoje).n;
      if (hojeNaCampanha >= ritmo.limiteDia) { await esperar(60); continue; }
      // O próximo número que ainda pode, pelo ritmo DELE (tela Canal: por
      // hora, intervalo e teto do dia), consultado antes de enviar.
      let numero = null, esperarS = 30;
      for (let k = 0; k < numeros.length && !numero; k++) {
        const n = numeros[(vez + k) % numeros.length];
        const doNumero = checarRitmo(tdb, loadProviderConfig(tdb, n.id));
        if (!doNumero.ok) { if (doNumero.esperar) esperarS = Math.min(esperarS, doNumero.esperar); continue; }
        numero = n; vez = (vez + k + 1) % numeros.length;
      }
      if (!numero) {
        for (let s = 0; s < Math.max(esperarS, 1) && !ctl.cancelled; s++) await sleep(1000);
        continue;
      }
      // Modelo com imagens manda a mensagem como legenda de uma delas,
      // sorteada a cada envio, como a campanha legado faz com as dela.
      const imagem = modeloId ? imagensModelo.sortear(slug, modeloId) : null;
      const texto = campAtual ? textoDoEnvio(tdb, campAtual, e).corpo : e.mensagemRenderizada;
      const r = imagem
        ? await enviarWhatsAppMidia(tdb, { telefone: e.destino, texto, imagePath: imagem, canalId: numero.id })
        : await enviarWhatsApp(tdb, { telefone: e.destino, texto, canalId: numero.id });
      if (r && r.segurado) continue;  // o ritmo mudou entre a consulta e o envio: escolhe de novo
      if (r && r.queued) break; // sem provider conectado
      if (r && r.success) tdb.prepare("UPDATE comm_envios SET status = 'enviado', dataEnvio = ?, dia = ?, canalId = ?, mensagemRenderizada = ? WHERE id = ?").run(new Date().toISOString(), hoje, numero.id, texto, e.id);
      else {
        tdb.prepare("UPDATE comm_envios SET status = 'falha', erro = ?, canalId = ?, mensagemRenderizada = ? WHERE id = ?").run((r && r.error) || 'falha', numero.id, texto, e.id);
        numerosWa.marcarPelaFalha(tdb, e.destino, r && r.error);   // "exists": false marca o número
      }
      const tot = tdb.prepare("SELECT SUM(CASE WHEN status='enviado' THEN 1 ELSE 0 END) AS env, SUM(CASE WHEN status='falha' THEN 1 ELSE 0 END) AS fal FROM comm_envios WHERE campanhaId = ? AND rodada = ?").get(campId, rodada);
      tdb.prepare("UPDATE comm_campanhas SET totalEnviados = ?, totalFalhas = ? WHERE id = ?").run(tot.env || 0, tot.fal || 0, campId);
      if (ctl.cancelled) break;
      // Com a fila vazia o laço encerra AQUI, sem pagar o intervalo. Esperar 45
      // a 120 s para descobrir que não há mais ninguém deixava a campanha em
      // 'enviando' esse tempo todo depois da última mensagem, e o "Enviar de
      // novo" recusado com "já está enviando" (campanha 5 do 1bit, 30/09).
      const resta = tdb.prepare(`SELECT 1 FROM comm_envios
        WHERE campanhaId = ? AND rodada = ? AND status = 'pendente' LIMIT 1`).get(campId, rodada);
      if (!resta) break;
      // `esperar`, e não `sleep`: em pedaços de 1 s, confere `ctl` a cada um.
      // O sleep único de até 120 s ignorava a pausa até acabar, e era ele que
      // segurava a chave em memória depois de o usuário mandar parar.
      await esperar(Math.round(ritmo.min + Math.random() * Math.max(0, ritmo.max - ritmo.min)));
    }
    const restam = tdb.prepare("SELECT COUNT(*) AS n FROM comm_envios WHERE campanhaId = ? AND rodada = ? AND status = 'pendente'").get(campId, rodada).n;
    tdb.prepare("UPDATE comm_campanhas SET status = ? WHERE id = ?")
      .run(ctl.pausado ? 'pausada' : ctl.cancelled ? 'cancelada' : (restam > 0 ? 'pausada' : 'enviada'), campId);
  } catch (e) {
    console.error('[comm-wa ' + key + ']', e.message);
  } finally {
    running.delete(key);
  }
}

// Prepara envios (se ainda não existem) e dispara o runner WhatsApp. Usado pelo
// /executar (HTTP) e pelo scheduler. Recebe o db REAL do tenant (tdb).
function dispararCommWhatsApp(tdb, slug, campId) {
  dest.migrarRodadas(tdb);
  const camp = tdb.prepare("SELECT c.*, t.canal, t.corpo FROM comm_campanhas c JOIN comm_templates t ON t.id = c.templateId WHERE c.id = ?").get(campId);
  if (!camp || camp.canal !== 'whatsapp') return false;
  if (running.has('comm:' + slug + ':' + campId)) return false;
  // Os envios são da rodada atual: a rodada nova prepara a lista inteira de novo.
  const rodada = camp.rodada || 1;
  const jaTem = tdb.prepare("SELECT COUNT(*) AS n FROM comm_envios WHERE campanhaId = ? AND rodada = ?").get(campId, rodada).n;
  if (!jaTem) {
    // Opt-out, destino inválido e repetido saem ANTES de virar envio: gravá-los
    // como 'pendente' e filtrar depois inflava o total de destinatários e fazia
    // a campanha prometer um alcance que não existia.
    dest.permitirEnvioAvulso(tdb);   // lista com contato avulso (sem ficha)
    const prep = dest.prepararDestinatarios(tdb, { listaId: camp.listaId, canal: 'whatsapp', tipo: camp.tipo,
      segmentos: segmentos.segmentosDaCampanha(camp) });
    const trxWa = tdb.transaction(() => {
      const stmt = tdb.prepare(`INSERT INTO comm_envios
        (campanhaId, pessoaId, canal, destino, mensagemRenderizada, assuntoRenderizado, status, motivoDescartado, rodada)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const d of prep.enviar) {
        stmt.run(campId, d.pessoa.id, 'whatsapp', d.destino, renderizar(camp.corpo, d.pessoa), null, 'pendente', null, rodada);
      }
      for (const d of prep.descartados) {
        stmt.run(campId, d.pessoaId, 'whatsapp', d.destino || null, null, null, 'descartado', d.motivo, rodada);
      }
      tdb.prepare('UPDATE comm_campanhas SET totalDestinatarios = ?, totalDescartados = ? WHERE id = ?')
        .run(prep.enviar.length, prep.descartados.length, campId);
    });
    trxWa();
  }
  tdb.prepare("UPDATE comm_campanhas SET status = 'enviando', dataEnvio = CURRENT_TIMESTAMP WHERE id = ?").run(campId);
  runCommWhatsApp(tdb, slug, campId).catch(e => console.error('[comm-wa]', e.message));
  return true;
}

const CANAIS = ['email', 'whatsapp'];
const STATUS_CAMP = ['rascunho', 'agendada', 'enviando', 'enviada', 'cancelada', 'pausada'];

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comm_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      canal TEXT NOT NULL,
      assunto TEXT,
      corpo TEXT NOT NULL,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_tpl_canal ON comm_templates(canal, ativo);

    CREATE TABLE IF NOT EXISTS comm_listas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE,
      descricao TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS comm_lista_membros (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listaId INTEGER NOT NULL,
      pessoaId INTEGER NOT NULL,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (listaId) REFERENCES comm_listas(id) ON DELETE CASCADE,
      FOREIGN KEY (pessoaId) REFERENCES pessoas(id),
      UNIQUE(listaId, pessoaId)
    );
    CREATE INDEX IF NOT EXISTS idx_membros_lista ON comm_lista_membros(listaId);

    CREATE TABLE IF NOT EXISTS comm_campanhas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      templateId INTEGER NOT NULL,
      listaId INTEGER NOT NULL,
      canal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'rascunho',
      agendadaPara TEXT,
      dataEnvio TEXT,
      totalDestinatarios INTEGER DEFAULT 0,
      totalEnviados INTEGER DEFAULT 0,
      totalFalhas INTEGER DEFAULT 0,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (templateId) REFERENCES comm_templates(id),
      FOREIGN KEY (listaId) REFERENCES comm_listas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_camp_status ON comm_campanhas(status, agendadaPara);

    CREATE TABLE IF NOT EXISTS comm_envios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campanhaId INTEGER NOT NULL,
      -- Opcional: contato avulso da lista não tem ficha (dest.permitirEnvioAvulso).
      pessoaId INTEGER,
      canal TEXT NOT NULL,
      destino TEXT,
      mensagemRenderizada TEXT,
      assuntoRenderizado TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      dataEnvio TEXT,
      erro TEXT,
      FOREIGN KEY (campanhaId) REFERENCES comm_campanhas(id) ON DELETE CASCADE,
      FOREIGN KEY (pessoaId) REFERENCES pessoas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_env_campanha ON comm_envios(campanhaId, status);
  `);
  const alterSafe = (sql) => {
    try { db.exec(sql); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  };
  // Imagem do modelo: a mensagem vira legenda dela no WhatsApp.
  alterSafe('ALTER TABLE comm_templates ADD COLUMN imagemPath TEXT');
  // Vários números de WhatsApp (whatsapp-canais.js): por quais a campanha sai,
  // e por qual cada envio saiu. O boot migra; isto cobre tabela nova.
  alterSafe('ALTER TABLE comm_campanhas ADD COLUMN canais TEXT');
  alterSafe('ALTER TABLE comm_envios ADD COLUMN canalId INTEGER');
  // Só alguns segmentos da lista (segmentos.js). O boot migra; isto cobre tabela nova.
  alterSafe('ALTER TABLE comm_campanhas ADD COLUMN segmentos TEXT');
  // O roteiro de qualificação da campanha (roteiro-conversa.js). O boot migra; isto cobre tabela nova.
  alterSafe('ALTER TABLE comm_campanhas ADD COLUMN roteiroId INTEGER');
  // A mesma campanha enviada mais de uma vez (comm-destinos.migrarRodadas).
  dest.migrarRodadas(db);
  // Contato avulso na lista: telefone digitado à mão, sem cadastro. Exige
  // pessoaId nulo, e a tabela nasceu com NOT NULL — daí a recriação, feita uma
  // única vez e preservando o que houver.
  alterSafe('ALTER TABLE comm_lista_membros ADD COLUMN destinoManual TEXT');
  alterSafe('ALTER TABLE comm_lista_membros ADD COLUMN nomeManual TEXT');
  try {
    const col = db.prepare('PRAGMA table_info(comm_lista_membros)').all().find(c => c.name === 'pessoaId');
    if (col && col.notnull) {
      db.exec('PRAGMA foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE comm_lista_membros_novo (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            listaId INTEGER NOT NULL,
            pessoaId INTEGER,
            destinoManual TEXT,
            nomeManual TEXT,
            dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (listaId) REFERENCES comm_listas(id) ON DELETE CASCADE,
            FOREIGN KEY (pessoaId) REFERENCES pessoas(id),
            UNIQUE(listaId, pessoaId),
            UNIQUE(listaId, destinoManual)
          );
          INSERT INTO comm_lista_membros_novo (id, listaId, pessoaId, destinoManual, nomeManual, dataCriacao)
            SELECT id, listaId, pessoaId, destinoManual, nomeManual, dataCriacao FROM comm_lista_membros;
          DROP TABLE comm_lista_membros;
          ALTER TABLE comm_lista_membros_novo RENAME TO comm_lista_membros;
          CREATE INDEX IF NOT EXISTS idx_membros_lista ON comm_lista_membros(listaId);
        `);
      })();
      db.exec('PRAGMA foreign_keys = ON');
    }
  } catch (e) { console.error('[comm] migração de membros avulsos:', e.message); }
}

// Renderização e resolução de destino moram em comm-destinos.js, junto da
// validação — separar levava a validar num lugar e enviar de outro.
const renderizar = dest.renderizar;
const destinoPara = (canal, pessoa) => dest.normalizarDestino(canal, dest.destinoBruto(canal, pessoa));

// Erro bloqueia; aviso vai junto na resposta. Assunto vazio não impede o
// envio, mas quem grava precisa saber que vai cair em spam.
function separar(problemas) {
  return {
    erros: problemas.filter((p) => p.nivel === 'erro'),
    avisos: problemas.filter((p) => p.nivel === 'aviso'),
  };
}

function registrarRotasComm(app, db) {
  migrarDB(db);
  dest.migrarDB(db);

  // ==================== TEMPLATES ====================

  app.get('/api/comm/templates', (req, res) => {
    try {
      // Quantas campanhas usam cada modelo. Sem isso, a tela lista modelos sem
      // dizer quais estão em uso, e remover um vira aposta.
      const lista = db.prepare(`SELECT t.*,
          (SELECT COUNT(*) FROM comm_campanhas c WHERE c.templateId = t.id) AS emUso
        FROM comm_templates t WHERE t.ativo = 1 ORDER BY t.canal, t.nome`).all();
      const slug = req.tenantCtx && req.tenantCtx.slug;
      res.json({ success: true, canais: CANAIS,
        templates: lista.map(t => ({ ...t, imagens: imagensModelo.listar(slug, t.id).length })) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/comm/templates', (req, res) => {
    try {
      const { nome, canal, assunto, corpo } = req.body;
      const { erros, avisos } = separar(dest.validarTemplate(req.body));
      if (erros.length) return res.status(400).json({ success: false, error: erros[0].mensagem, problemas: erros });

      const r = db.prepare('INSERT INTO comm_templates (nome, canal, assunto, corpo) VALUES (?, ?, ?, ?)').run(nome, canal, assunto || null, corpo);
      logAction(db, req, 'criar', 'comm-template', r.lastInsertRowid, { nome, canal });
      res.json({ success: true, avisos, template: db.prepare('SELECT * FROM comm_templates WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/comm/templates/:id', (req, res) => {
    try {
      const camposValidos = ['nome','canal','assunto','corpo','ativo'];

      const atual = db.prepare('SELECT * FROM comm_templates WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Template não encontrado' });

      // Valida o estado final: corrigir só o corpo ainda precisa resultar num
      // template que não mande "{{fone}}" literal para o cliente.
      const final = { ...atual, ...req.body };
      const { erros, avisos } = separar(dest.validarTemplate(final));
      if (erros.length) return res.status(400).json({ success: false, error: erros[0].mensagem, problemas: erros });

      const sets = [], vals = [];
      for (const c of camposValidos) {
        if (req.body[c] !== undefined) {
          if (c === 'canal' && !CANAIS.includes(req.body[c])) return res.status(400).json({ success: false, error: 'canal inválido' });
          sets.push(`${c} = ?`);
          vals.push(c === 'ativo' ? (req.body[c] ? 1 : 0) : req.body[c]);
        }
      }
      if (!sets.length) return res.json({ success: true });
      vals.push(req.params.id);
      db.prepare(`UPDATE comm_templates SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      logAction(db, req, 'editar', 'comm-template', req.params.id, req.body);
      res.json({ success: true, avisos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Imagens e vídeos do modelo: um conjunto, e cada envio sorteia um
   * (comm-imagens.js). O arquivo é validado pela assinatura, e não pela
   * extensão, como a foto de produto. Até 28/09 era uma imagem só, em
   * `imagemPath`, que nenhum modelo chegou a usar; a coluna ficou no banco, sem
   * leitura. Vídeo entrou em 30/09, a pedido, e só em MP4.
   */
  const slugDe = (req) => (req.tenantCtx && req.tenantCtx.slug) || 'default';
  const modeloOu404 = (req, res) => {
    const t = db.prepare('SELECT id FROM comm_templates WHERE id = ?').get(req.params.id);
    if (!t) res.status(404).json({ success: false, error: 'Modelo não encontrado' });
    return t;
  };

  app.get('/api/comm/templates/:id/imagens', (req, res) => {
    try {
      if (!modeloOu404(req, res)) return;
      res.json({ success: true, imagens: imagensModelo.listar(slugDe(req), req.params.id), max: imagensModelo.MAX_IMAGENS });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/comm/templates/:id/imagens/:arquivo', (req, res) => {
    const c = imagensModelo.caminho(slugDe(req), req.params.id, req.params.arquivo);
    if (!c) return res.status(404).end();
    res.sendFile(c);
  });

  // reentrarContextoTenant logo depois do multer: o busboy lê o corpo em
  // callbacks que perdem o contexto do tenant, e o db respondia "currentDb()
  // chamado fora de contexto de tenant" (imagem do modelo do 1bit, 29/09).
  // Arquivo acima do teto do multer estoura antes do handler, e sem este
  // tratamento a tela recebia um 500 sem motivo no lugar do tamanho.
  const receberArquivo = (req, res, next) => uploadImagem.single('imagem')(req, res, (e) => (e
    ? res.status(400).json({ success: false,
        error: e.code === 'LIMIT_FILE_SIZE'
          ? `O arquivo passa de ${Math.round(imagensModelo.MAX_VIDEO_BYTES / 1048576)} MB`
          : e.message })
    : next()));

  app.post('/api/comm/templates/:id/imagens', receberArquivo, reentrarContextoTenant, (req, res) => {
    try {
      if (!modeloOu404(req, res)) return;
      const nome = imagensModelo.adicionar(slugDe(req), req.params.id, req.file && req.file.buffer);
      logAction(db, req, 'imagem', 'comm-template', req.params.id, { arquivo: nome });
      res.json({ success: true, arquivo: nome, imagens: imagensModelo.listar(slugDe(req), req.params.id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/comm/templates/:id/imagens/:arquivo', (req, res) => {
    try {
      if (!modeloOu404(req, res)) return;
      if (!imagensModelo.remover(slugDe(req), req.params.id, req.params.arquivo)) {
        return res.status(404).json({ success: false, error: 'Imagem não encontrada' });
      }
      res.json({ success: true, imagens: imagensModelo.listar(slugDe(req), req.params.id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/comm/templates/:id', (req, res) => {
    try {
      db.prepare('UPDATE comm_templates SET ativo = 0 WHERE id = ?').run(req.params.id);
      logAction(db, req, 'desativar', 'comm-template', req.params.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== LISTAS ====================

  // Os segmentos do cadastro de pessoas, só para leitura: as telas de
  // comunicação filtram por eles, e o RBAC não lhes dá /api/pessoas.
  app.get('/api/comm/segmentos', (req, res) => {
    try { res.json({ success: true, segmentos: segmentos.listarSegmentos(db) }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/comm/listas', (req, res) => {
    try {
      const listas = db.prepare(`
        SELECT l.*,
          (SELECT COUNT(*) FROM comm_lista_membros m WHERE m.listaId = l.id) AS qtdMembros
        FROM comm_listas l
        WHERE l.ativo = 1
        ORDER BY l.nome
      `).all();
      res.json({ success: true, listas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Membros de uma lista.
   *
   * O JOIN com `pessoas` era interno, e isso escondia lista inteira: membro
   * importado do legado entra com `destinoManual` e sem `pessoaId`, então as
   * três listas do 1bit (27.775 contatos) devolviam zero. Agora o vínculo com
   * o cadastro é opcional, e quem não tem aparece com o nome e o telefone que
   * foram gravados na importação.
   *
   * Pagina porque uma dessas listas tem 15.595 linhas: mandar tudo de uma vez
   * trava a tela no navegador do cliente.
   */
  app.get('/api/comm/listas/:id', (req, res) => {
    try {
      const lista = db.prepare('SELECT * FROM comm_listas WHERE id = ?').get(req.params.id);
      if (!lista) return res.status(404).json({ success: false, error: 'Lista não encontrada' });
      const q = String(req.query.q || '').trim().toLowerCase();
      const porPagina = Math.min(Number(req.query.porPagina) || 100, 500);
      const pagina = Math.max(Number(req.query.pagina) || 1, 1);

      let filtro = q
        ? `AND (LOWER(COALESCE(${leadFicha.nomeExibido('p')}, m.nomeManual, '')) LIKE @q
             OR COALESCE(p.telefone, m.destinoManual, '') LIKE @q)`
        : '';
      if (req.query.segmento) filtro += ' AND p.segmentoId = @segmento';
      const args = { listaId: lista.id, q: `%${q}%`, segmento: Number(req.query.segmento) || 0 };
      const total = db.prepare(`SELECT COUNT(*) n FROM comm_lista_membros m
        LEFT JOIN pessoas p ON p.id = m.pessoaId
        WHERE m.listaId = @listaId ${filtro}`).get(args).n;

      const membros = db.prepare(`
        SELECT m.id, m.pessoaId, p.segmentoId, p.categorias,
               COALESCE(${leadFicha.nomeExibido('p')}, m.nomeManual) AS nome,
               COALESCE(p.telefone, m.destinoManual) AS telefone,
               p.cpfCnpj, p.email,
               CASE WHEN m.pessoaId IS NULL THEN 'manual' ELSE 'cadastro' END AS vinculo
        FROM comm_lista_membros m
        LEFT JOIN pessoas p ON p.id = m.pessoaId
        WHERE m.listaId = @listaId ${filtro}
        ORDER BY nome IS NULL, nome
        LIMIT @limite OFFSET @offset
      `).all({ ...args, limite: porPagina, offset: (pagina - 1) * porPagina });

      // Quantos da lista em cada segmento, para o filtro da tela. Contato
      // sem ficha (avulso de antes da migração) fica em segmentoId nulo.
      const porSegmento = db.prepare(`SELECT p.segmentoId, COUNT(*) n FROM comm_lista_membros m
        LEFT JOIN pessoas p ON p.id = m.pessoaId
        WHERE m.listaId = ? GROUP BY p.segmentoId`).all(lista.id);

      // Sem WhatsApp (wa-numeros.js): a marca é do número, então sai pelo
      // telefone normalizado de cada contato, e o total conta a lista inteira.
      let semWhatsapp = 0;
      try {
        const marcados = new Set(db.prepare('SELECT destino FROM wa_numeros WHERE existe = 0').all().map(r => r.destino));
        if (marcados.size) {
          const tem = (tel) => marcados.has(dest.normalizarDestino('whatsapp', tel));
          for (const m of membros) m.semWhatsapp = tem(m.telefone);
          semWhatsapp = db.prepare(`SELECT COALESCE(p.telefone, m.destinoManual) AS tel FROM comm_lista_membros m
            LEFT JOIN pessoas p ON p.id = m.pessoaId WHERE m.listaId = ?`).all(lista.id).filter(x => tem(x.tel)).length;
        }
      } catch (_) { /* sem a tabela ainda */ }
      const verificacao = numerosWa.situacao(db, lista.id);

      res.json({ success: true, lista, membros, total, pagina, porPagina, porSegmento, semWhatsapp, verificacao });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/comm/listas', (req, res) => {
    try {
      const { nome, descricao } = req.body;
      if (!nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      const r = db.prepare('INSERT INTO comm_listas (nome, descricao) VALUES (?, ?)').run(nome, descricao || null);
      logAction(db, req, 'criar', 'comm-lista', r.lastInsertRowid, { nome });
      res.json({ success: true, lista: db.prepare('SELECT * FROM comm_listas WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/comm/listas/:id', (req, res) => {
    try {
      const { nome, descricao, ativo } = req.body;
      const sets = [], vals = [];
      if (nome !== undefined)      { sets.push('nome = ?');      vals.push(nome); }
      if (descricao !== undefined) { sets.push('descricao = ?'); vals.push(descricao); }
      if (ativo !== undefined)     { sets.push('ativo = ?');     vals.push(ativo ? 1 : 0); }
      if (!sets.length) return res.json({ success: true });
      vals.push(req.params.id);
      db.prepare(`UPDATE comm_listas SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      logAction(db, req, 'editar', 'comm-lista', req.params.id, req.body);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/comm/listas/:id', (req, res) => {
    try {
      db.prepare('UPDATE comm_listas SET ativo = 0 WHERE id = ?').run(req.params.id);
      logAction(db, req, 'desativar', 'comm-lista', req.params.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Adicionar clientes do cadastro (lote). O contato avulso entra pela
  // importação de planilha, logo abaixo.
  app.post('/api/comm/listas/:id/membros', (req, res) => {
    try {
      const { pessoaIds } = req.body;
      if (!Array.isArray(pessoaIds) || !pessoaIds.length) {
        return res.status(400).json({ success: false, error: 'Selecione clientes' });
      }
      const stmt = db.prepare('INSERT OR IGNORE INTO comm_lista_membros (listaId, pessoaId) VALUES (?, ?)');
      let adic = 0;
      db.transaction(() => {
        for (const pid of pessoaIds) { if (stmt.run(req.params.id, pid).changes) adic++; }
      })();
      logAction(db, req, 'add-membros', 'comm-lista', req.params.id, { quantidade: adic });
      res.json({ success: true, adicionados: adic, doCadastro: adic });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  /** Importa contatos avulsos de uma planilha (campo `arquivo`). */
  app.post('/api/comm/listas/:id/importar', uploadPlanilha.single('arquivo'), reentrarContextoTenant, (req, res) => {
    try {
      const lista = db.prepare('SELECT id, nome FROM comm_listas WHERE id = ?').get(req.params.id);
      if (!lista) return res.status(404).json({ success: false, error: 'Lista não encontrada' });
      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({ success: false, error: 'Escolha a planilha' });
      }
      let linhas;
      try { linhas = lerPlanilhaDeContatos(req.file.buffer); }
      catch (e) { return res.status(400).json({ success: false, error: e.message }); }
      if (!linhas.length) return res.status(400).json({ success: false, error: 'A planilha não tem contatos abaixo dos títulos' });
      const r = adicionarContatos(db, lista, linhas);
      if (!r.adicionados && !r.repetidos) {
        return res.status(400).json({ success: false, recusados: r.recusados,
          error: `Nenhum telefone válido na planilha. Recusados: ${r.recusados.slice(0, 3).join(', ')}` });
      }
      logAction(db, req, 'importar-membros', 'comm-lista', lista.id, { arquivo: req.file.originalname, ...r, recusados: r.recusados.length });
      res.json({ success: true, ...r });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  /**
   * Verifica na Evolution quais números da lista não têm WhatsApp
   * (wa-numeros.js), em segundo plano e devagar. O GET acompanha.
   */
  app.post('/api/comm/listas/:id/verificar-whatsapp', (req, res) => {
    try {
      const lista = db.prepare('SELECT id FROM comm_listas WHERE id = ?').get(req.params.id);
      if (!lista) return res.status(404).json({ success: false, error: 'Lista não encontrada' });
      const slug = req.tenantCtx && req.tenantCtx.slug;
      const { trabalho, ...situacao } = numerosWa.verificarLista(req.tenantDb || db, slug, lista.id);
      logAction(db, req, 'verificar-whatsapp', 'comm-lista', lista.id, { total: situacao.total });
      res.json({ success: true, verificacao: situacao });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.get('/api/comm/listas/:id/verificar-whatsapp', (req, res) => {
    try { res.json({ success: true, verificacao: numerosWa.situacao(db, Number(req.params.id)) }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * O segmento de um contato da lista. Grava na FICHA da pessoa, e não no
   * membro: o mesmo contato em duas listas tem um segmento só. Contato ainda
   * sem ficha (avulso de antes da migração) ganha a dele aqui.
   */
  app.put('/api/comm/listas/membros/:id', (req, res) => {
    try {
      const m = db.prepare(`SELECT m.id, m.pessoaId, m.destinoManual, m.nomeManual, l.nome AS listaNome
        FROM comm_lista_membros m JOIN comm_listas l ON l.id = m.listaId WHERE m.id = ?`).get(req.params.id);
      if (!m) return res.status(404).json({ success: false, error: 'Contato não encontrado na lista' });
      const segmentoId = Number(req.body?.segmentoId);
      if (!segmentoId || !db.prepare('SELECT 1 FROM segmentos WHERE id = ?').get(segmentoId)) {
        return res.status(400).json({ success: false, error: 'Escolha um segmento do cadastro' });
      }
      const pessoaId = db.transaction(() => {
        let id = m.pessoaId;
        if (!id) {
          id = leadFicha.fichaDoContato(db, leadFicha.indiceDeTelefones(db),
            { destino: m.destinoManual, nome: m.nomeManual, segmentoId, fonte: `Importação da lista ${m.listaNome}` }).pessoaId;
          db.prepare('UPDATE comm_lista_membros SET pessoaId = ? WHERE id = ?').run(id, m.id);
        }
        db.prepare('UPDATE pessoas SET segmentoId = ? WHERE id = ?').run(segmentoId, id);
        return id;
      })();
      res.json({ success: true, pessoaId, segmentoId });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/comm/listas/membros/:id', (req, res) => {
    try {
      db.prepare('DELETE FROM comm_lista_membros WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CAMPANHAS ====================

  app.get('/api/comm/campanhas', (req, res) => {
    try {
      const lista = db.prepare(`
        SELECT c.*, t.nome AS templateNome, t.canal AS templateCanal, l.nome AS listaNome
        FROM comm_campanhas c
        JOIN comm_templates t ON t.id = c.templateId
        JOIN comm_listas l ON l.id = c.listaId
        ORDER BY c.id DESC LIMIT 200
      `).all();
      res.json({ success: true, campanhas: lista, status: STATUS_CAMP });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/comm/campanhas/:id', (req, res) => {
    try {
      const camp = db.prepare(`
        SELECT c.*, t.nome AS templateNome, t.canal AS templateCanal, t.assunto, t.corpo,
               l.nome AS listaNome
        FROM comm_campanhas c
        JOIN comm_templates t ON t.id = c.templateId
        JOIN comm_listas l ON l.id = c.listaId
        WHERE c.id = ?
      `).get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
      // Os envios de UMA rodada: a atual, ou a pedida em ?rodada=N.
      const rodada = Number(req.query.rodada) || camp.rodada || 1;
      // LEFT JOIN: envio para contato avulso não tem ficha, e o nome dele vem da
      // própria lista. Com JOIN simples esses envios sumiam de "Ver envios".
      const envios = db.prepare(`
        SELECT e.*, COALESCE(${leadFicha.nomeExibido('p')},
          (SELECT m.nomeManual FROM comm_lista_membros m WHERE m.listaId = ? AND m.destinoManual = e.destino LIMIT 1)) AS razaoSocial
        FROM comm_envios e LEFT JOIN pessoas p ON p.id = e.pessoaId
        WHERE e.campanhaId = ? AND e.rodada = ? ORDER BY e.id DESC LIMIT 1000
      `).all(camp.listaId, camp.id, rodada);
      // Uma linha por rodada que já gerou envio, com os números dela.
      const rodadas = db.prepare(`SELECT rodada,
          SUM(status IN ('enviado','simulado')) AS enviados, SUM(status = 'falha') AS falhas,
          SUM(status = 'descartado') AS descartados, SUM(status = 'pendente') AS pendentes,
          MIN(dataEnvio) AS inicio, MAX(dataEnvio) AS fim
        FROM comm_envios WHERE campanhaId = ? GROUP BY rodada ORDER BY rodada`).all(camp.id);
      const rodando = running.has('comm:' + (req.tenantCtx && req.tenantCtx.slug) + ':' + camp.id);
      res.json({ success: true, campanha: camp, envios, rodada, rodadas, rodando });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/comm/campanhas', (req, res) => {
    try {
      const { nome, templateId, listaId, agendadaPara, observacoes } = req.body;
      if (!nome || !templateId || !listaId) return res.status(400).json({ success: false, error: 'nome, templateId e listaId obrigatórios' });
      const tipo = req.body.tipo || 'marketing';
      if (!dest.TIPOS_CAMPANHA.includes(tipo)) {
        return res.status(400).json({ success: false,
          error: `tipo deve ser ${dest.TIPOS_CAMPANHA.join(' ou ')} — 'marketing' respeita o consentimento do cadastro` });
      }
      const t = db.prepare('SELECT * FROM comm_templates WHERE id = ?').get(templateId);
      if (!t) return res.status(404).json({ success: false, error: 'Template não encontrado' });
      const l = db.prepare('SELECT * FROM comm_listas WHERE id = ?').get(listaId);
      if (!l) return res.status(404).json({ success: false, error: 'Lista não encontrada' });
      // Só alguns segmentos da lista (vazio = a lista inteira).
      const segs = segmentos.validarSegmentos(db, req.body.segmentos);
      const totalDest = publicoDaLista(db, listaId, segs);
      // Por quais números sai (vazio = o padrão). Só WhatsApp tem número.
      const numeros = t.canal === 'whatsapp' ? canais.validarNumeros(db, req.body.canais) : [];
      const r = db.prepare(`
        INSERT INTO comm_campanhas (nome, templateId, listaId, canal, status, agendadaPara, totalDestinatarios, observacoes, tipo, canais, segmentos, ritmo, roteiroId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(nome, templateId, listaId, t.canal, agendadaPara ? 'agendada' : 'rascunho', agendadaPara || null, totalDest, observacoes || null, tipo,
             numeros.length ? JSON.stringify(numeros) : null, segs.length ? JSON.stringify(segs) : null, validarRitmo(req.body.ritmo),
             require('./roteiro-conversa').roteiroEscolhido(db, req.body.roteiroId));
      logAction(db, req, 'criar', 'comm-campanha', r.lastInsertRowid, { nome, totalDest });
      res.json({ success: true, campanha: db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Executar agora (modo simulado: marca cada envio como 'simulado').
  // Provider real pode ser plugado depois — basta processar envios 'pendente'.
  app.post('/api/comm/campanhas/:id/executar', async (req, res) => {
    try {
      const camp = db.prepare(`
        SELECT c.*, t.canal, t.assunto, t.corpo
        FROM comm_campanhas c JOIN comm_templates t ON t.id = c.templateId
        WHERE c.id = ?
      `).get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (!['rascunho','agendada','pausada'].includes(camp.status)) {
        return res.status(400).json({ success: false, error: `Campanha em status '${camp.status}' não pode ser executada` });
      }

      // Janela de envio: mensagem às 3h da manhã rende denúncia, não venda. No
      // WhatsApp, desde 29/09 é o motor que confere o horário DA CAMPANHA a
      // cada envio e espera; aqui só se avisa quando ela vai começar. O e-mail
      // sai todo de uma vez, e continua recusando fora da janela.
      const janela = dest.janelaPermitida(db);
      if (camp.canal !== 'whatsapp' && !janela.permitido && !req.body?.ignorarJanela) {
        return res.status(400).json({ success: false,
          error: `Envio ${janela.motivo}. Reenvie dentro da janela ou mande ignorarJanela para forçar.`,
          janela });
      }

      // Canal WhatsApp: envio REAL em background (throttle/limite-dia/opt-out).
      // Email segue o caminho simulado abaixo (inalterado).
      if (camp.canal === 'whatsapp') {
        let escolhidos = null;
        try { escolhidos = camp.canais ? JSON.parse(camp.canais) : null; } catch (_) { /* lista ilegível: vale o padrão */ }
        const { erro: semNumero } = canais.numerosDaCampanha(db, escolhidos);
        if (semNumero) return res.status(400).json({ success: false, error: semNumero });
        const slug = req.tenantCtx && req.tenantCtx.slug;
        const tdb = req.tenantDb;
        if (!slug || !tdb) return res.status(400).json({ success: false, error: 'tenant não resolvido' });
        // A mensagem diz o que esperar: "já está enviando" fazia quem acabara de
        // pausar clicar de novo em sequência, sem saber que o laço leva alguns
        // segundos para largar a campanha.
        if (running.has('comm:' + slug + ':' + camp.id)) {
          return res.status(409).json({ success: false,
            error: 'Esta campanha ainda está no ar. Se você acabou de pausar, o envio em curso termina em alguns segundos' });
        }
        dispararCommWhatsApp(tdb, slug, camp.id);
        logAction(db, req, 'executar', 'comm-campanha', camp.id, { canal: 'whatsapp' });
        const { horario } = ritmoDaCampanha(tdb, camp);
        const aguarda = horario && !dentroDoExpediente(horario.faixas, new Date())
          ? `fora do horário da campanha (${horario.inicio} às ${horario.fim}). O envio começa quando o horário abrir.` : null;
        return res.json({ success: true, started: true, canal: 'whatsapp', aguarda });
      }

      // Reexecutar não pode reenviar para quem já recebeu. Antes, uma campanha
      // 'pausada' executada de novo inseria a lista inteira outra vez — cada
      // pessoa recebendo em duplicado.
      const rodada = camp.rodada || 1;
      const jaPreparada = db.prepare('SELECT COUNT(*) n FROM comm_envios WHERE campanhaId = ? AND rodada = ?').get(camp.id, rodada).n;
      if (!jaPreparada) {
        dest.permitirEnvioAvulso(db);   // lista com contato avulso (sem ficha)
        const prep = dest.prepararDestinatarios(db, { listaId: camp.listaId, canal: camp.canal, tipo: camp.tipo,
          segmentos: segmentos.segmentosDaCampanha(camp) });
        const trxPrep = db.transaction(() => {
          const stmt = db.prepare(`INSERT INTO comm_envios
            (campanhaId, pessoaId, canal, destino, mensagemRenderizada, assuntoRenderizado, status, motivoDescartado, rodada)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const d of prep.enviar) {
            stmt.run(camp.id, d.pessoa.id, camp.canal, d.destino,
              renderizar(camp.corpo, d.pessoa), renderizar(camp.assunto, d.pessoa), 'pendente', null, rodada);
          }
          for (const d of prep.descartados) {
            stmt.run(camp.id, d.pessoaId, camp.canal, d.destino || null, null, null, 'descartado', d.motivo, rodada);
          }
          db.prepare('UPDATE comm_campanhas SET totalDestinatarios = ?, totalDescartados = ? WHERE id = ?')
            .run(prep.enviar.length, prep.descartados.length, camp.id);
        });
        trxPrep();
      }

      db.prepare("UPDATE comm_campanhas SET status = 'enviando', dataEnvio = CURRENT_TIMESTAMP WHERE id = ?").run(camp.id);

      const pendentes = db.prepare(
        "SELECT * FROM comm_envios WHERE campanhaId = ? AND rodada = ? AND status = 'pendente' ORDER BY id").all(camp.id, rodada);
      const temSmtp = !!loadSmtpConfig(db);

      if (!temSmtp) {
        // Sem SMTP a mensagem não sai. Marcar 'enviada' com N enviados era a
        // tela afirmando um envio que nunca aconteceu.
        const trxSim = db.transaction(() => {
          const upd = db.prepare("UPDATE comm_envios SET status = 'simulado', dataEnvio = ? WHERE id = ?");
          for (const e of pendentes) upd.run(new Date().toISOString(), e.id);
          db.prepare("UPDATE comm_campanhas SET status = 'simulada', totalEnviados = 0 WHERE id = ?").run(camp.id);
        });
        trxSim();
        logAction(db, req, 'executar-simulado', 'comm-campanha', camp.id, { simulados: pendentes.length });
        return res.json({ success: true, simulacao: true, simulados: pendentes.length, enviados: 0,
          aviso: 'SMTP não configurado — nada foi enviado de verdade. '
               + 'Configure o e-mail em Configurações para disparar a campanha.' });
      }

      // Fora da transação: envio é I/O, e prender o banco por minutos travaria
      // o tenant inteiro.
      let env = 0;
      const erros = [];
      const marcarOk = db.prepare("UPDATE comm_envios SET status = 'enviado', dataEnvio = ?, dia = ?, mensagemRenderizada = ?, assuntoRenderizado = ? WHERE id = ?");
      const marcarFalha = db.prepare("UPDATE comm_envios SET status = 'falha', erro = ? WHERE id = ?");
      const hoje = new Date().toISOString().slice(0, 10);

      for (const e of pendentes) {
        let r;
        const txt = textoDoEnvio(db, camp, e);
        try {
          r = await enviarEmailSimples(db, {
            to: e.destino, assunto: txt.assunto, texto: txt.corpo,
            // Cabeçalho padrão que clientes de e-mail usam para o botão de
            // descadastro. Sem ele a denúncia de spam substitui o opt-out.
            headers: { 'List-Unsubscribe': `<mailto:${(loadSmtpConfig(db) || {}).user || ''}?subject=DESCADASTRAR>` },
          });
        } catch (err) { r = { success: false, error: err.message }; }

        if (r && r.success) { marcarOk.run(new Date().toISOString(), hoje, txt.corpo, txt.assunto, e.id); env++; }
        else { marcarFalha.run((r && r.error) || 'falha no envio', e.id); erros.push({ destino: e.destino, erro: r && r.error }); }
      }

      const tot = db.prepare(`SELECT
          SUM(CASE WHEN status='enviado' THEN 1 ELSE 0 END) AS env,
          SUM(CASE WHEN status='falha' THEN 1 ELSE 0 END) AS fal,
          SUM(CASE WHEN status='descartado' THEN 1 ELSE 0 END) AS desc,
          SUM(CASE WHEN status='pendente' THEN 1 ELSE 0 END) AS pend
        FROM comm_envios WHERE campanhaId = ? AND rodada = ?`).get(camp.id, rodada);
      db.prepare(`UPDATE comm_campanhas SET status = ?, totalEnviados = ?, totalFalhas = ?, totalDescartados = ?
        WHERE id = ?`).run(tot.pend > 0 ? 'pausada' : 'enviada', tot.env || 0, tot.fal || 0, tot.desc || 0, camp.id);

      logAction(db, req, 'executar', 'comm-campanha', camp.id, { enviados: env, falhas: erros.length });
      res.json({ success: true, enviados: env, falhas: erros.length,
        descartados: tot.desc || 0, erros: erros.slice(0, 20) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  /**
   * Abre a próxima rodada de uma campanha que terminou: a lista inteira recebe
   * de novo, inclusive quem já recebeu. A campanha volta a rascunho e sai pelo
   * mesmo "Enviar" (agora ou agendado). As rodadas anteriores ficam nos envios,
   * com o texto que cada um recebeu; os totais da campanha passam a ser os da
   * rodada nova.
   */
  app.post('/api/comm/campanhas/:id/nova-rodada', (req, res) => {
    try {
      const camp = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
      if (!['enviada', 'cancelada'].includes(camp.status)) {
        return res.status(400).json({ success: false,
          error: `Campanha ${camp.status} ainda não terminou. A próxima rodada abre depois que esta acabar` });
      }
      const rodada = (camp.rodada || 1) + 1;
      const total = publicoDaLista(db, camp.listaId, segmentos.segmentosDaCampanha(camp));
      db.prepare(`UPDATE comm_campanhas SET rodada = ?, status = 'rascunho', agendadaPara = NULL, dataEnvio = NULL,
          totalDestinatarios = ?, totalEnviados = 0, totalFalhas = 0, totalDescartados = 0 WHERE id = ?`)
        .run(rodada, total, camp.id);
      logAction(db, req, 'nova-rodada', 'comm-campanha', camp.id, { rodada });
      res.json({ success: true, campanha: db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(camp.id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  /**
   * Edita a campanha enquanto ela ainda não saiu.
   *
   * Depois de enviada não se edita: o texto e o público daquele envio são o
   * registro do que o destinatário recebeu, e reescrevê-los apagaria a prova.
   * Trocar template ou lista recalcula o total de destinatários.
   */
  app.put('/api/comm/campanhas/:id', (req, res) => {
    try {
      const camp = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
      if (camp.status === 'enviando') {
        return res.status(400).json({ success: false,
          error: 'Campanha enviando não pode ser editada. Pause antes' });
      }
      const b = req.body || {};
      // Pausada, a lista da rodada já está preparada: nome, modelo e números
      // mudam (o texto sai do modelo na hora de cada envio), mas quem recebe,
      // não. Lista, segmentos e tipo mudam na próxima rodada.
      const pausada = camp.status === 'pausada';
      /**
       * Enviada ou cancelada: editável por inteiro, a pedido (30/09). Antes a
       * rota recusava, e as campanhas "(cópia)" do 1bit ficavam sem "Editar" na
       * tela assim que saíam, obrigando a duplicar de novo para mudar uma
       * palavra. O que já foi enviado não muda com isto: as linhas de
       * `comm_envios` da rodada feita ficam como estão, e a edição vale para a
       * rodada seguinte, a que o "Enviar de novo" abre.
       */
      const finalizada = ['enviada', 'cancelada'].includes(camp.status);
      if (pausada) {
        const ordenar = (v) => JSON.stringify([...(v || [])].map(Number).sort((x, y) => x - y));
        if ((b.listaId != null && Number(b.listaId) !== camp.listaId)
            || (b.segmentos !== undefined && ordenar(b.segmentos) !== ordenar(segmentos.segmentosDaCampanha(camp)))
            || (b.tipo != null && b.tipo !== camp.tipo)) {
          return res.status(400).json({ success: false,
            error: 'Com a campanha pausada, quem recebe não muda. Lista, segmentos e tipo mudam na próxima rodada' });
        }
      }

      let templateId = camp.templateId, canal = camp.canal;
      if (b.templateId != null && Number(b.templateId) !== camp.templateId) {
        const t = db.prepare('SELECT * FROM comm_templates WHERE id = ?').get(Number(b.templateId));
        if (!t) return res.status(404).json({ success: false, error: 'Template não encontrado' });
        if (pausada && t.canal !== camp.canal) {
          return res.status(400).json({ success: false, error: `A campanha pausada sai por ${camp.canal}; escolha um modelo de ${camp.canal}` });
        }
        templateId = t.id; canal = t.canal;
      }
      let listaId = camp.listaId;
      if (b.listaId != null && Number(b.listaId) !== camp.listaId) {
        const l = db.prepare('SELECT * FROM comm_listas WHERE id = ?').get(Number(b.listaId));
        if (!l) return res.status(404).json({ success: false, error: 'Lista não encontrada' });
        listaId = l.id;
      }
      let tipo = camp.tipo;
      if (b.tipo != null && b.tipo !== camp.tipo) {
        if (!dest.TIPOS_CAMPANHA.includes(b.tipo)) {
          return res.status(400).json({ success: false, error: `tipo deve ser ${dest.TIPOS_CAMPANHA.join(' ou ')}` });
        }
        tipo = b.tipo;
      }
      const nome = b.nome != null ? String(b.nome).trim() : camp.nome;
      if (!nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });

      const agendadaPara = b.agendadaPara !== undefined ? (b.agendadaPara || null) : camp.agendadaPara;
      const segs = b.segmentos !== undefined ? segmentos.validarSegmentos(db, b.segmentos) : segmentos.segmentosDaCampanha(camp);
      const total = publicoDaLista(db, listaId, segs);

      let numeros = camp.canais;
      if (b.canais !== undefined) {
        const limpos = canal === 'whatsapp' ? canais.validarNumeros(db, b.canais) : [];
        numeros = limpos.length ? JSON.stringify(limpos) : null;
      }
      // Ritmo e horário mudam também com a campanha pausada: não mudam quem recebe.
      const ritmo = b.ritmo !== undefined ? validarRitmo(b.ritmo) : camp.ritmo;
      // O roteiro de qualificação muda também com a campanha pausada: quem já
      // começou fica no roteiro que começou (roteiro-conversa.js).
      const roteiroId = b.roteiroId !== undefined ? require('./roteiro-conversa').roteiroEscolhido(db, b.roteiroId) : (camp.roteiroId || null);
      db.prepare(`UPDATE comm_campanhas SET nome = ?, templateId = ?, listaId = ?, canal = ?, tipo = ?,
          agendadaPara = ?, status = ?, totalDestinatarios = ?, observacoes = ?, canais = ?, segmentos = ?, ritmo = ?, roteiroId = ? WHERE id = ?`)
        // O status da finalizada é preservado: regravar 'rascunho' apagaria o
        // fato de ela ter saído, e a tela trocaria "Enviar de novo", que abre a
        // rodada seguinte, por "Enviar", que repetiria a rodada atual.
        .run(nome, templateId, listaId, canal, tipo, pausada || finalizada ? camp.agendadaPara : agendadaPara,
             pausada ? 'pausada' : finalizada ? camp.status : agendadaPara ? 'agendada' : 'rascunho',
             pausada ? camp.totalDestinatarios : total,
             b.observacoes !== undefined ? (b.observacoes || null) : camp.observacoes, numeros,
             segs.length ? JSON.stringify(segs) : null, ritmo, roteiroId, camp.id);
      logAction(db, req, 'editar', 'comm-campanha', camp.id, { nome, totalDest: total });
      res.json({ success: true, campanha: db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(camp.id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  /** Duplica uma campanha (inclusive enviada) para reaproveitar texto e público. */
  app.post('/api/comm/campanhas/:id/duplicar', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
      const total = publicoDaLista(db, c.listaId, segmentos.segmentosDaCampanha(c));
      const nome = String(req.body?.nome || `${c.nome} (cópia)`).trim().slice(0, 120);
      const r = db.prepare(`INSERT INTO comm_campanhas
          (nome, templateId, listaId, canal, status, totalDestinatarios, observacoes, tipo, canais, segmentos, ritmo, roteiroId)
        VALUES (?, ?, ?, ?, 'rascunho', ?, ?, ?, ?, ?, ?, ?)`)
        .run(nome, c.templateId, c.listaId, c.canal, total, c.observacoes || null, c.tipo, c.canais || null, c.segmentos || null,
             c.ritmo || null, c.roteiroId || null);
      logAction(db, req, 'duplicar', 'comm-campanha', r.lastInsertRowid, { de: c.id });
      res.json({ success: true, campanha: db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  /**
   * Pausa a campanha em curso. Diferente de cancelar: os envios seguem
   * 'pendente' e um /executar depois continua de onde parou.
   */
  app.post('/api/comm/campanhas/:id/pausar', (req, res) => {
    try {
      const camp = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (['enviada', 'cancelada'].includes(camp.status)) {
        return res.status(400).json({ success: false, error: `Campanha ${camp.status} não está em execução` });
      }
      const ctl = running.get('comm:' + (req.tenantCtx && req.tenantCtx.slug) + ':' + camp.id);
      // `cancelled` só encerra o laço; `pausado` diz ao motor que o status final
      // é 'pausada'. Sem ele o motor gravava 'cancelada' por cima ao sair, e a
      // campanha pausada perdia o "Retomar" (campanha 3 do 1bit, 29/09).
      if (ctl) { ctl.pausado = true; ctl.cancelled = true; }
      // Agendada que é pausada perde o agendamento: sem isso o scheduler a
      // dispararia de novo em no máximo 2 minutos.
      db.prepare("UPDATE comm_campanhas SET status = 'pausada', agendadaPara = NULL WHERE id = ?").run(camp.id);
      logAction(db, req, 'pausar', 'comm-campanha', camp.id, null);
      res.json({ success: true, emExecucao: !!ctl });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /** Agenda (ou desagenda, com quando=null) o início do disparo. */
  app.post('/api/comm/campanhas/:id/agendar', (req, res) => {
    try {
      const camp = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (['enviada', 'cancelada'].includes(camp.status)) {
        return res.status(400).json({ success: false, error: `Campanha ${camp.status} não pode ser agendada` });
      }
      const quando = req.body?.quando;
      if (!quando) {
        db.prepare("UPDATE comm_campanhas SET agendadaPara = NULL, status = 'rascunho' WHERE id = ?").run(camp.id);
        return res.json({ success: true, agendadaPara: null });
      }
      const d = new Date(quando);
      if (isNaN(d.getTime())) return res.status(400).json({ success: false, error: 'Data inválida' });
      db.prepare("UPDATE comm_campanhas SET agendadaPara = ?, status = 'agendada' WHERE id = ?")
        .run(d.toISOString(), camp.id);
      logAction(db, req, 'agendar', 'comm-campanha', camp.id, { quando: d.toISOString() });
      res.json({ success: true, agendadaPara: d.toISOString() });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.post('/api/comm/campanhas/:id/cancelar', (req, res) => {
    try {
      const camp = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (['enviada','cancelada'].includes(camp.status)) return res.status(400).json({ success: false, error: 'Estado não permite cancelar' });
      const ctl = running.get('comm:' + (req.tenantCtx && req.tenantCtx.slug) + ':' + camp.id);
      if (ctl) ctl.cancelled = true; // sinaliza o runner (whatsapp)
      db.prepare(`UPDATE comm_campanhas SET status = 'cancelada' WHERE id = ?`).run(camp.id);
      logAction(db, req, 'cancelar', 'comm-campanha', camp.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== OPT-OUT ====================

  app.get('/api/comm/optout', (req, res) => {
    try {
      const { canal, q } = req.query;
      let sql = `SELECT o.*, p.razaoSocial FROM comm_optout o
                 LEFT JOIN pessoas p ON p.id = o.pessoaId WHERE 1=1`;
      const params = [];
      if (canal) { sql += ' AND o.canal = ?'; params.push(canal); }
      if (q) { sql += ' AND (o.destino LIKE ? OR p.razaoSocial LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
      sql += ' ORDER BY o.dataCriacao DESC LIMIT 1000';
      const registros = db.prepare(sql).all(...params);
      const porCanal = db.prepare('SELECT canal, COUNT(*) n FROM comm_optout GROUP BY canal').all();
      res.json({ success: true, registros, porCanal });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/comm/optout', (req, res) => {
    try {
      const r = dest.registrarOptOut(db, { ...req.body, origem: req.body?.origem || 'manual' });
      logAction(db, req, 'registrar-optout', 'comm', null, r);
      res.json({ success: true, ...r });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Reinclusão exige confirmação: desfazer um "não me mande mais" é decisão de
  // risco, não correção de digitação.
  app.delete('/api/comm/optout', (req, res) => {
    try {
      const { canal, destino, confirmar } = req.body || {};
      if (confirmar !== true) {
        return res.status(400).json({ success: false,
          error: 'Reinclusão exige confirmar: true — a pessoa pediu para não receber' });
      }
      const r = dest.removerOptOut(db, canal, destino);
      if (!r.removidos) return res.status(404).json({ success: false, error: 'Destino não estava em opt-out' });
      logAction(db, req, 'remover-optout', 'comm', null, { canal, destino });
      res.json({ success: true, ...r });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ==================== PRÉVIA DA CAMPANHA ====================

  // Quem realmente vai receber, antes de disparar. Uma campanha que diz
  // "500 enviados" sem dizer que 120 estavam em opt-out dá uma taxa de sucesso
  // que não existe.
  app.get('/api/comm/campanhas/:id/previa', (req, res) => {
    try {
      const camp = db.prepare(`SELECT c.*, t.canal, t.assunto, t.corpo
        FROM comm_campanhas c JOIN comm_templates t ON t.id = c.templateId WHERE c.id = ?`).get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Campanha não encontrada' });

      const prep = dest.prepararDestinatarios(db, { listaId: camp.listaId, canal: camp.canal, tipo: camp.tipo,
        segmentos: segmentos.segmentosDaCampanha(camp) });
      const problemas = dest.validarTemplate({ nome: 'x', canal: camp.canal, assunto: camp.assunto, corpo: camp.corpo });
      const janela = dest.janelaPermitida(db);
      const temSmtp = camp.canal === 'email' ? !!loadSmtpConfig(db) : null;

      res.json({
        success: true,
        canal: camp.canal,
        tipo: camp.tipo || 'marketing',
        resumo: prep.resumo,
        descartados: prep.descartados.slice(0, 200),
        exemplos: prep.enviar.slice(0, 3).map((d) => ({
          destino: d.destino, nome: d.pessoa.razaoSocial,
          assunto: renderizar(camp.assunto, d.pessoa),
          corpo: renderizar(camp.corpo, d.pessoa),
        })),
        problemasTemplate: problemas,
        // "0 elegíveis" sem explicação faz o usuário achar que o sistema
        // quebrou, quando o que falta é o aceite ter sido coletado.
        consentimento: (camp.tipo || 'marketing') === 'marketing'
          ? dest.diagnosticoConsentimento(db, camp.canal) : null,
        janela,
        envioReal: camp.canal === 'email'
          ? (temSmtp || false)
          : !!(loadProviderConfig(db) || {}).instance,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Pré-visualização (renderiza para um destinatário)
  app.post('/api/comm/preview', (req, res) => {
    try {
      const { templateId, pessoaId } = req.body;
      const t = db.prepare('SELECT * FROM comm_templates WHERE id = ?').get(templateId);
      if (!t) return res.status(404).json({ success: false, error: 'Template não encontrado' });
      const p = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(pessoaId);
      if (!p) return res.status(404).json({ success: false, error: 'Pessoa não encontrada' });
      res.json({
        success: true,
        canal: t.canal,
        assunto: renderizar(t.assunto, p),
        corpo: renderizar(t.corpo, p),
        destino: destinoPara(t.canal, p)
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasComm, runCommWhatsApp, dispararCommWhatsApp };
