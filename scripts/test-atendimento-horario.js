/**
 * Horário de atendimento — a porta que CALA a resposta automática.
 *
 * ── Por que esta suíte é mais dura que as outras ───────────────────────────
 *
 * Todo defeito aqui é silencioso e caro nos dois sentidos. Fechar cedo demais
 * faz o cliente receber "estamos fechados" às duas da tarde. Abrir demais faz a
 * IA prometer retorno às três da manhã. Nenhum dos dois aparece em log, em tela
 * ou em erro: aparece no cliente.
 *
 * O caso que motivou a checagem de fuso: o banco grava em UTC e a unit systemd
 * pode subir com TZ diferente. Um `new Date().getHours()` funcionaria hoje e
 * fecharia a empresa três horas mais cedo no dia em que alguém mexesse na unit.
 * Por isso os testes de fuso comparam o MESMO instante em três TZ de processo.
 *
 * ── O teste que prova a ordem das portas ───────────────────────────────────
 *
 * O aviso de fora do expediente vem DEPOIS do escopo no webhook. Se alguém
 * inverter, quem a empresa decidiu não abordar passa a receber mensagem
 * automática de madrugada. O teste F1 lê o fonte e confere a ordem, porque é o
 * único jeito de checar ordenação de guardas sem subir a Evolution inteira.
 */
const fs = require('fs');
const path = require('path');
const H = require('../atendimento-horario');

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

const COMERCIAL = { seg:['08:00','18:00'], ter:['08:00','18:00'], qua:['08:00','18:00'],
                    qui:['08:00','18:00'], sex:['08:00','18:00'], sab:['08:00','12:00'], dom:null };

/** Instante em horário de Brasília (UTC-3 o ano todo desde 2019). */
const brt = (iso) => new Date(iso + '-03:00');

// ==================== A. dentro e fora ====================

t('A1. terca as 10h esta dentro', () => {
  assert(H.dentroDoExpediente(COMERCIAL, brt('2026-09-15T10:00')), 'fechou no meio do expediente');
});

t('A2. terca as 19h esta fora', () => {
  assert(!H.dentroDoExpediente(COMERCIAL, brt('2026-09-15T19:00')), 'atendeu depois de fechar');
});

t('A3. terca as 7h59 ainda esta fora, e as 8h00 ja esta dentro', () => {
  assert(!H.dentroDoExpediente(COMERCIAL, brt('2026-09-15T07:59')), '7h59 deveria estar fora');
  assert(H.dentroDoExpediente(COMERCIAL, brt('2026-09-15T08:00')), '8h00 em ponto deveria abrir');
});

t('A4. o fim da faixa NAO atende: 18h00 ja esta fechado', () => {
  // Quem fecha às 18h fecha às 18h. Atender "só mais essa" às 18h00 em ponto é
  // o tipo de regra que ninguém escreveu e que a equipe descobre reclamando.
  assert(!H.dentroDoExpediente(COMERCIAL, brt('2026-09-15T18:00')), '18h00 deveria estar fechado');
  assert(H.dentroDoExpediente(COMERCIAL, brt('2026-09-15T17:59')), '17h59 deveria estar aberto');
});

t('A5. domingo esta fechado o dia inteiro', () => {
  for (const hora of ['00:00', '10:00', '15:30', '23:59']) {
    assert(!H.dentroDoExpediente(COMERCIAL, brt('2026-09-13T' + hora)),
      `domingo às ${hora} apareceu como aberto`);
  }
});

t('A6. sabado tem faixa propria e fecha ao meio-dia', () => {
  assert(H.dentroDoExpediente(COMERCIAL, brt('2026-09-19T11:00')), 'sábado 11h deveria atender');
  assert(!H.dentroDoExpediente(COMERCIAL, brt('2026-09-19T13:00')), 'sábado 13h deveria estar fechado');
});

// ==================== B. plantao que vira o dia ====================

const PLANTAO = { seg:['22:00','06:00'], ter:['22:00','06:00'], qua:null, qui:null,
                  sex:null, sab:null, dom:null };

t('B1. faixa que atravessa a meia-noite atende antes das 24h', () => {
  assert(H.dentroDoExpediente(PLANTAO, brt('2026-09-14T23:00')), 'segunda 23h deveria atender');
});

t('B2. e continua atendendo depois da meia-noite, no dia seguinte', () => {
  // Sem a leitura da faixa de ONTEM, o plantão fecharia à meia-noite em ponto,
  // no meio do turno, e ninguém entenderia por quê.
  assert(H.dentroDoExpediente(PLANTAO, brt('2026-09-15T02:00')),
    'terça 2h da manhã é a continuação do turno de segunda');
});

t('B3. mas fecha no fim da faixa da madrugada', () => {
  assert(!H.dentroDoExpediente(PLANTAO, brt('2026-09-15T06:30')), '6h30 já passou do fim do plantão');
});

t('B4. a madrugada de quarta NAO herda plantao de terca-feira fechada', () => {
  assert(H.dentroDoExpediente(PLANTAO, brt('2026-09-16T02:00')),
    'quarta 2h é continuação de terça, que tem plantão');
  assert(!H.dentroDoExpediente(PLANTAO, brt('2026-09-17T02:00')),
    'quinta 2h herdou plantão de quarta, que está fechada');
});

// ==================== C. fuso ====================

t('C1. o mesmo instante decide igual em qualquer TZ do processo', () => {
  // 21h em Brasília = meia-noite em UTC. Um sistema que lesse a hora local do
  // processo diria "domingo 00h" rodando em UTC e fecharia sábado mais cedo.
  const instante = brt('2026-09-15T21:00');   // terça, 21h BRT: FORA
  const tzOriginal = process.env.TZ;
  const resultados = [];
  for (const tz of ['America/Sao_Paulo', 'UTC', 'Asia/Tokyo']) {
    process.env.TZ = tz;
    resultados.push(H.dentroDoExpediente(COMERCIAL, instante));
  }
  process.env.TZ = tzOriginal;
  assert(resultados.every(r => r === false),
    'a decisão mudou com o TZ do processo: ' + JSON.stringify(resultados));
});

t('C2. a hora lida e a de Brasilia, nao a do processo', () => {
  const m = H.momento(brt('2026-09-15T14:30'));
  assert(m.dia === 'ter' && m.minuto === 14 * 60 + 30,
    `leu ${m.dia} ${Math.floor(m.minuto / 60)}h${m.minuto % 60}`);
});

t('C3. meia-noite em Brasilia le 00:00, e nao 24:00', () => {
  const m = H.momento(brt('2026-09-15T00:00'));
  assert(m.minuto === 0, `meia-noite virou minuto ${m.minuto} — a faixa do dia inteiro quebraria`);
});

// ==================== D. na duvida, atende ====================

t('D1. configuracao ausente NAO fecha o atendimento', () => {
  // Uma porta que cala a IA e que se fecha sozinha por falta de configuração
  // deixaria o atendimento mudo sem ninguém entender. Na dúvida, atende.
  assert(H.dentroDoExpediente(null, brt('2026-09-13T03:00')), 'sem faixas, deveria atender');
  assert(H.dentroDoExpediente({}, brt('2026-09-13T03:00')), 'com objeto vazio, deveria atender');
  const todosFechados = { seg:null, ter:null, qua:null, qui:null, sex:null, sab:null, dom:null };
  assert(H.dentroDoExpediente(todosFechados, brt('2026-09-15T10:00')),
    'agenda com os sete dias fechados calaria a IA para sempre — isso é gravação '
    + 'incompleta, não expediente');
});

t('D2. hora invalida no dia nao fecha os OUTROS dias', () => {
  const quebrado = { ...COMERCIAL, ter: ['xx:yy', '18:00'] };
  assert(!H.dentroDoExpediente(quebrado, brt('2026-09-15T10:00')), 'terça quebrada não tem faixa válida');
  assert(H.dentroDoExpediente(quebrado, brt('2026-09-16T10:00')), 'quarta continua com a faixa dela');
});

t('D3. JSON quebrado na config nao derruba a leitura', () => {
  const cfg = (k) => ({ whatsapp_horario_ativo: '1', whatsapp_horario_faixas: '{isso não é json' })[k] || '';
  const h = H.lerHorario(cfg);
  assert(h.faixas === null, 'faixas deveria vir nula');
  assert(H.foraDoExpediente(cfg, brt('2026-09-13T03:00')) === null,
    'com faixas ilegíveis, o atendimento segue normal em vez de calar');
});

// ==================== E. a decisao que o webhook consulta ====================

const cfgDe = (o) => (k) => (o[k] !== undefined ? o[k] : '');

t('E1. desligado, nunca esta fora do expediente', () => {
  const cfg = cfgDe({ whatsapp_horario_ativo: '0', whatsapp_horario_faixas: JSON.stringify(COMERCIAL) });
  assert(H.foraDoExpediente(cfg, brt('2026-09-13T03:00')) === null,
    'domingo de madrugada calou a IA com o horário DESLIGADO');
});

t('E2. ligado e fora da faixa, devolve a mensagem configurada', () => {
  const cfg = cfgDe({ whatsapp_horario_ativo: '1', whatsapp_horario_faixas: JSON.stringify(COMERCIAL),
                      whatsapp_horario_msg: 'Atendemos de 8h às 18h.' });
  const r = H.foraDoExpediente(cfg, brt('2026-09-13T03:00'));
  assert(r && r.mensagem === 'Atendemos de 8h às 18h.', 'não devolveu a mensagem: ' + JSON.stringify(r));
});

t('E3. ligado e DENTRO da faixa, o atendimento segue normal', () => {
  const cfg = cfgDe({ whatsapp_horario_ativo: '1', whatsapp_horario_faixas: JSON.stringify(COMERCIAL),
                      whatsapp_horario_msg: 'Atendemos de 8h às 18h.' });
  assert(H.foraDoExpediente(cfg, brt('2026-09-15T10:00')) === null, 'calou a IA em pleno expediente');
});

t('E4. sem mensagem configurada, devolve fora com mensagem vazia', () => {
  const cfg = cfgDe({ whatsapp_horario_ativo: '1', whatsapp_horario_faixas: JSON.stringify(COMERCIAL) });
  const r = H.foraDoExpediente(cfg, brt('2026-09-13T03:00'));
  assert(r && r.mensagem === '', 'deveria indicar fora do expediente com mensagem vazia');
});

// ==================== F. a ordem das portas no webhook ====================

t('F1. o horario e consultado DEPOIS do escopo de campanha', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'whatsapp-webhook.js'), 'utf8');
  const escopo = fonte.indexOf("whatsapp_ai_escopo");
  const horario = fonte.indexOf('foraDoExpediente');
  assert(escopo > 0 && horario > 0, 'não achei as duas portas no webhook');
  assert(escopo < horario,
    'a porta do horário passou na frente do escopo — com isso, quem a empresa '
    + 'decidiu NÃO abordar por resposta automática passa a receber aviso de madrugada');
});

t('F2. o aviso nao se repete a cada mensagem', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'whatsapp-webhook.js'), 'utf8');
  const trecho = fonte.slice(fonte.indexOf('foraDoExpediente'), fonte.indexOf('foraDoExpediente') + 1400);
  assert(/from_bot = 1 AND texto = \?/.test(trecho) && /8 \* 3600/.test(trecho),
    'não há janela de repetição: três mensagens de madrugada devolveriam três avisos iguais');
});

// ==================== G. convivência com o servidor antigo ====================
//
// A tela é estática e entra no ar ao salvar; o backend só no restart. Entre os
// dois momentos, o formulário do horário não pode aparecer: a pessoa marcaria a
// caixa, escreveria a mensagem, salvaria, e nada seria gravado.
//
// Aqui se verifica a PRESENÇA das guardas no fonte. É menos que executá-las, e
// está escrito assim de propósito: o que elas protegem é uma janela de algumas
// horas, e montar DOM para isso custaria mais do que a janela dura.

t('G1. o bloco do horario nasce escondido', () => {
  const tela = fs.readFileSync(path.join(__dirname, '..', 'public/comunicacao/ia.html'), 'utf8');
  assert(/id="horBloco"[^>]*style="display:none;?"/.test(tela),
    'o bloco do horário nasce visível — com o servidor antigo, seria um formulário que não grava nada');
});

t('G2. so renderHorario revela o bloco, e ela so roda se o servidor mandar horario', () => {
  const tela = fs.readFileSync(path.join(__dirname, '..', 'public/comunicacao/ia.html'), 'utf8');
  assert(/if \(ia\.horario\) renderHorario\(ia\.horario\)/.test(tela),
    'renderHorario é chamada sem conferir se o servidor devolveu horário');
  assert(/function renderHorario[\s\S]{0,200}horBloco'\)\.style\.display = ''/.test(tela),
    'renderHorario não revela o bloco');
});

t('G3. salvar sem a agenda desenhada nao manda horario nenhum', () => {
  // Executa a função da tela contra um DOM mínimo, em vez de procurar a linha
  // dela por texto: a guarda mudou de lugar quando a grade de dias passou a ser
  // compartilhada com a agenda de reunião, e a checagem antiga reprovou sem que
  // nada tivesse deixado de funcionar. Teste que mede a forma do código
  // envelhece na primeira refatoração.
  const tela = fs.readFileSync(path.join(__dirname, '..', 'public/comunicacao/ia.html'), 'utf8');
  const pega = (nome) => {
    const m = new RegExp('function ' + nome + '\\([\\s\\S]*?\\n\\}').exec(tela);
    assert(m, `função ${nome} não encontrada na tela`);
    return m[0];
  };
  const fonte = pega('lerGradeDeDias') + '\n' + pega('lerHorarioDaTela');
  const rodar = (grade) => new Function('document', 'HOR_DIAS',
    fonte + '\nreturn lerHorarioDaTela();')(
      { getElementById: (id) => id === 'horDias' ? grade : { checked: true, value: '', disabled: false } },
      [['seg', 'Segunda']]);

  assert(rodar({ children: { length: 0 } }) === null,
    'com a agenda ausente mandaria faixas vazias para o servidor, apagando o expediente');
  const cheia = rodar({ children: { length: 7 } });
  assert(cheia && cheia.faixas, 'com a agenda desenhada precisa devolver as faixas');
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
