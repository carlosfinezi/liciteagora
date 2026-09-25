/**
 * Agendamento de reunião pelo próprio lead.
 *
 * ── Por que tudo é string local, e não Date ────────────────────────────────
 *
 * `crm_atividades.dataHora` já grava hora local sem fuso ('2026-07-24T14:00'),
 * e é dela que sai a agenda que a equipe lê. Este módulo fala a MESMA língua:
 * horário livre, horário ocupado e "a partir de quando" são todos strings no
 * formato 'AAAA-MM-DDTHH:MM'. Nesse formato a ordem alfabética é a ordem do
 * relógio, então comparar é comparar texto, e não existe conversão de fuso no
 * meio do caminho — que é justamente onde nasceriam os erros de três horas.
 *
 * O fuso aparece em dois lugares só, os dois via `Intl`, que não depende do TZ
 * com que o processo subiu: para saber que dia e que hora são agora no
 * escritório, e para carimbar o `.ics`, que por especificação vai em UTC.
 *
 * ── O que é oferecido ──────────────────────────────────────────────────────
 *
 * Os próximos horários livres, e não um calendário de semanas. Quatorze dias à
 * frente é longe demais para uma reunião comercial: a lista curta é o que faz
 * o lead escolher agora, e o primeiro da lista é o que a tela sugere.
 */

const { DIAS, FUSO, minutos } = require('./atendimento-horario');

const PADRAO = {
  duracaoMin: 30,
  antecedenciaMin: 120,   // 2 horas: ninguém marca reunião para daqui a 10 minutos
  janelaDias: 7,
  maxSlots: 8,
};

/** 'AAAA-MM-DD' e dia da semana de um instante, no fuso do escritório. */
function diaLocal(instante) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(instante).map(x => [x.type, x.value]));
  const idx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { data: `${p.year}-${p.month}-${p.day}`, dia: DIAS[idx] };
}

/** 'AAAA-MM-DDTHH:MM' de um instante, no fuso do escritório. */
function momentoLocal(instante) {
  const { data } = diaLocal(instante);
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(instante).map(x => [x.type, x.value]));
  return `${data}T${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`;
}

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Os próximos horários livres.
 *
 * `faixas` segue o formato do horário de atendimento ({ seg: ['09:00','18:00'],
 * dom: null }), `ocupados` é a lista de 'AAAA-MM-DDTHH:MM' já comprometidos, e
 * `agora` entra por parâmetro porque é isso que torna o cálculo testável.
 *
 * Faixa que atravessa a meia-noite é aceita no expediente da IA, mas aqui ela é
 * cortada no fim do dia: reunião das 23h30 às 00h00 do dia seguinte não é um
 * compromisso que alguém queira ver na agenda, e tratá-la exigiria regra para
 * um caso que não existe em agenda comercial.
 */
function proximosHorarios(opts = {}) {
  const cfg = { ...PADRAO, ...opts };
  const faixas = cfg.faixas || {};
  const ocupados = new Set(cfg.ocupados || []);
  const agora = cfg.agora || new Date();

  // O primeiro instante aceitável, já em string local: a comparação seguinte é
  // texto contra texto, sem fuso nenhum no meio.
  const minimo = momentoLocal(new Date(agora.getTime() + cfg.antecedenciaMin * 60000));

  const livres = [];
  for (let d = 0; d < cfg.janelaDias && livres.length < cfg.maxSlots; d++) {
    // Meio-dia evita que somar 24h caia no mesmo dia por mudança de offset.
    const instante = new Date(agora.getTime() + d * 86400000);
    const { data, dia } = diaLocal(instante);
    const faixa = faixas[dia];
    if (!Array.isArray(faixa)) continue;                    // dia fechado
    const de = minutos(faixa[0]), ate = minutos(faixa[1]);
    if (de === null || ate === null || ate <= de) continue;  // inválida ou vira o dia

    for (let m = de; m + cfg.duracaoMin <= ate; m += cfg.duracaoMin) {
      const quando = `${data}T${hhmm(m)}`;
      if (quando < minimo || ocupados.has(quando)) continue;
      livres.push(quando);
      if (livres.length >= cfg.maxSlots) break;
    }
  }
  return livres;
}

/** Offset do fuso naquele instante, em minutos (-180 para Brasília). */
function offsetMinutos(instante) {
  const nome = new Intl.DateTimeFormat('en-US', { timeZone: FUSO, timeZoneName: 'longOffset' })
    .formatToParts(instante).find(p => p.type === 'timeZoneName').value;    // 'GMT-03:00'
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(nome);
  if (!m) return 0;
  const min = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -min : min;
}

/** O instante UTC de um horário local 'AAAA-MM-DDTHH:MM'. */
function paraUtc(local) {
  const provisorio = new Date(local + ':00Z');
  return new Date(provisorio.getTime() - offsetMinutos(provisorio) * 60000);
}

const carimbo = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * O convite .ics.
 *
 * Vai em UTC por especificação, o que dispensa carregar a definição do fuso
 * dentro do arquivo. Quem abrir no celular vê a hora local do próprio aparelho,
 * e para quem está no mesmo fuso do escritório é a hora combinada.
 *
 * `uid` precisa ser estável: reenviar o convite do mesmo compromisso tem de
 * atualizar o evento no calendário de quem recebeu, e não criar um segundo.
 */
function gerarIcs({ uid, inicio, duracaoMin = PADRAO.duracaoMin, titulo, descricao, organizador, cancelado }) {
  const ini = paraUtc(inicio);
  const fim = new Date(ini.getTime() + duracaoMin * 60000);
  const escapar = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const linhas = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LiciteAgora//Agenda//PT-BR',
    `METHOD:${cancelado ? 'CANCEL' : 'REQUEST'}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${carimbo(new Date())}`,
    `DTSTART:${carimbo(ini)}`,
    `DTEND:${carimbo(fim)}`,
    `SUMMARY:${escapar(titulo)}`,
    ...(descricao ? [`DESCRIPTION:${escapar(descricao)}`] : []),
    ...(organizador ? [`ORGANIZER;CN=${escapar(organizador)}:mailto:nao-responda@liciteagora.com.br`] : []),
    `STATUS:${cancelado ? 'CANCELLED' : 'CONFIRMED'}`,
    ...(cancelado ? ['SEQUENCE:1'] : ['SEQUENCE:0']),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  // CRLF é exigido pela RFC 5545; com \n sozinho o Outlook recusa o arquivo.
  return linhas.join('\r\n') + '\r\n';
}

/** Texto do horário para uma pessoa ler: 'sexta, 19/09 às 14:00'. */
function porExtenso(local) {
  const [data, hora] = String(local || '').split('T');
  const [a, m, d] = String(data || '').split('-');
  if (!a || !hora) return String(local || '');
  const nome = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][
    new Date(`${data}T12:00:00Z`).getUTCDay()];
  return `${nome}, ${d}/${m} às ${hora}`;
}

/** Config do tenant, com os padrões de quem nunca configurou nada. */
function lerConfig(getValor) {
  const num = (chave, padrao) => {
    const v = Number(getValor(chave));
    return Number.isFinite(v) && v > 0 ? v : padrao;
  };
  let faixas = null;
  try { faixas = JSON.parse(getValor('agenda_faixas') || 'null'); } catch { faixas = null; }
  return {
    ativo: getValor('agenda_ativo') === '1',
    faixas: faixas && typeof faixas === 'object' ? faixas : null,
    duracaoMin: num('agenda_duracao_min', PADRAO.duracaoMin),
    antecedenciaMin: num('agenda_antecedencia_min', PADRAO.antecedenciaMin),
    janelaDias: num('agenda_janela_dias', PADRAO.janelaDias),
    maxSlots: num('agenda_max_slots', PADRAO.maxSlots),
  };
}

module.exports = { PADRAO, proximosHorarios, gerarIcs, porExtenso, lerConfig,
                   diaLocal, momentoLocal, paraUtc };
