/**
 * Agendamento de reunião: o cálculo dos horários e o convite .ics.
 *
 * ── Por que o relógio entra por parâmetro ──────────────────────────────────
 *
 * Toda checagem aqui fixa o instante "agora". Suíte que lê o relógio do sistema
 * passa hoje e reprova numa segunda-feira de feriado, e aí alguém a desliga em
 * vez de consertá-la.
 *
 * ── O que está guardado ────────────────────────────────────────────────────
 *
 * Os quatro modos de falha que fariam o lead marcar um horário que não existe:
 * fora da faixa, em dia fechado, em cima de compromisso já marcado, e dentro da
 * antecedência mínima. Mais o fuso do `.ics`, que é onde um erro de três horas
 * passaria despercebido até o cliente aparecer na hora errada.
 */
const path = require('path');

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const { proximosHorarios, gerarIcs, porExtenso, lerConfig, momentoLocal, paraUtc } =
  require('../agenda-reuniao');

// Comercial: segunda a sexta, 9h às 12h e nada à tarde, para a conta fechar na mão.
const FAIXAS = { seg: ['09:00', '12:00'], ter: ['09:00', '12:00'], qua: ['09:00', '12:00'],
                 qui: ['09:00', '12:00'], sex: ['09:00', '12:00'], sab: null, dom: null };

// Sexta, 18/09/2026, 08:00 no fuso do escritório (11:00Z).
const SEXTA_8H = new Date('2026-09-18T11:00:00Z');

t('A1. o relogio e lido no fuso do escritorio, nao no do processo', () => {
  assert(momentoLocal(SEXTA_8H) === '2026-09-18T08:00', momentoLocal(SEXTA_8H));
});

t('A2. so oferece horario dentro da faixa do dia', () => {
  const s = proximosHorarios({ faixas: FAIXAS, agora: SEXTA_8H, maxSlots: 20 });
  const hoje = s.filter(x => x.startsWith('2026-09-18'));
  assert(hoje[0] === '2026-09-18T10:00', `o primeiro de hoje é ${hoje[0]}`);
  assert(hoje[hoje.length - 1] === '2026-09-18T11:30', `o último de hoje é ${hoje[hoje.length - 1]}`);
  assert(!s.some(x => x.endsWith('T12:00')), 'ofereceu o horário que termina depois do fim da faixa');
});

t('A3. a antecedencia minima corta o que esta perto demais', () => {
  // 08:00 + 2h = 10:00. As 09:00 e 09:30 de hoje não podem aparecer.
  const s = proximosHorarios({ faixas: FAIXAS, agora: SEXTA_8H, maxSlots: 20 });
  assert(!s.includes('2026-09-18T09:00'), 'ofereceu horário dentro da antecedência');
  assert(!s.includes('2026-09-18T09:30'), 'ofereceu horário dentro da antecedência');
  assert(s.includes('2026-09-18T10:00'), 'o primeiro horário válido sumiu');
});

t('A4. dia fechado nao aparece', () => {
  // Sexta 18h: o resto de sexta já passou, sábado e domingo são fechados.
  const s = proximosHorarios({ faixas: FAIXAS, agora: new Date('2026-09-18T21:00:00Z'), maxSlots: 5 });
  assert(s.every(x => !x.startsWith('2026-09-19') && !x.startsWith('2026-09-20')),
    'ofereceu sábado ou domingo: ' + s.join(', '));
  assert(s[0] === '2026-09-21T09:00', `o próximo deveria ser segunda 9h, veio ${s[0]}`);
});

t('A5. horario ja comprometido some da lista', () => {
  const s = proximosHorarios({ faixas: FAIXAS, agora: SEXTA_8H, maxSlots: 20,
    ocupados: ['2026-09-18T10:00', '2026-09-18T11:00'] });
  assert(!s.includes('2026-09-18T10:00'), 'ofereceu horário ocupado');
  assert(!s.includes('2026-09-18T11:00'), 'ofereceu horário ocupado');
  assert(s.includes('2026-09-18T10:30'), 'comeu um horário que estava livre');
});

t('A6. a lista respeita o teto, e o primeiro e a sugestao da tela', () => {
  const s = proximosHorarios({ faixas: FAIXAS, agora: SEXTA_8H });
  assert(s.length === 8, `vieram ${s.length} horários para um teto de 8`);
  assert(s[0] === '2026-09-18T10:00', `a sugestão seria ${s[0]}`);
});

t('A7. agenda lotada devolve lista vazia, e nao um horario qualquer', () => {
  const s = proximosHorarios({ faixas: { seg: null, ter: null, qua: null, qui: null,
                                         sex: null, sab: null, dom: null }, agora: SEXTA_8H });
  assert(s.length === 0, 'inventou horário numa agenda sem nenhum dia aberto');
});

t('A8. faixa que atravessa a meia-noite nao vira reuniao', () => {
  const s = proximosHorarios({ faixas: { ...FAIXAS, sex: ['22:00', '06:00'] },
    agora: SEXTA_8H, maxSlots: 3 });
  assert(!s.some(x => x.startsWith('2026-09-18')), 'marcou reunião na madrugada: ' + s.join(', '));
});

t('B1. o .ics leva a hora certa em UTC', () => {
  // 14:00 em Brasília (-03) são 17:00Z. Errar isto põe o cliente na sala três
  // horas depois, e nada no sistema acusaria.
  const ics = gerarIcs({ uid: 'x@liciteagora', inicio: '2026-09-18T14:00', titulo: 'Conversa' });
  assert(/DTSTART:20260918T170000Z/.test(ics), ics.split('\r\n').find(l => l.startsWith('DTSTART')));
  assert(/DTEND:20260918T173000Z/.test(ics), 'a duração de 30 min não bateu');
});

t('B2. o .ics fecha o formato que Outlook e Google exigem', () => {
  const ics = gerarIcs({ uid: 'x@liciteagora', inicio: '2026-09-18T14:00', titulo: 'Conversa' });
  assert(ics.startsWith('BEGIN:VCALENDAR'), 'não começa em VCALENDAR');
  assert(ics.trimEnd().endsWith('END:VCALENDAR'), 'não termina em VCALENDAR');
  assert(ics.includes('\r\n'), 'quebra de linha sem CRLF — o Outlook recusa');
  assert(/UID:x@liciteagora/.test(ics), 'sem UID, reenviar cria um segundo evento');
});

t('B3. cancelamento e outro arquivo, nao a ausencia de um', () => {
  const ics = gerarIcs({ uid: 'x@liciteagora', inicio: '2026-09-18T14:00', titulo: 'Conversa', cancelado: true });
  assert(/METHOD:CANCEL/.test(ics) && /STATUS:CANCELLED/.test(ics), 'o cancelamento não se identifica');
  assert(/SEQUENCE:1/.test(ics), 'sem SEQUENCE maior, o calendário ignora a atualização');
});

t('B4. virgula e quebra de linha nao quebram o arquivo', () => {
  const ics = gerarIcs({ uid: 'x@y', inicio: '2026-09-18T14:00',
    titulo: 'Reunião: preço, prazo', descricao: 'linha 1\nlinha 2' });
  assert(/SUMMARY:Reunião: preço\\, prazo/.test(ics), 'a vírgula não foi escapada');
  assert(/DESCRIPTION:linha 1\\nlinha 2/.test(ics), 'a quebra de linha não foi escapada');
});

t('C1. o horario aparece por extenso para quem le', () => {
  assert(porExtenso('2026-09-18T14:00') === 'sexta, 18/09 às 14:00', porExtenso('2026-09-18T14:00'));
});

t('C2. tenant sem configuracao nenhuma tem padrao utilizavel e DESLIGADO', () => {
  const c = lerConfig(() => '');
  assert(c.ativo === false, 'o agendamento nasceria ligado sem ninguém ter pedido');
  assert(c.duracaoMin === 30 && c.antecedenciaMin === 120, 'os padrões mudaram');
  assert(c.faixas === null, 'inventou faixa para quem não configurou');
});

t('C3. configuracao invalida cai no padrao em vez de zerar a agenda', () => {
  const c = lerConfig((k) => ({ agenda_duracao_min: '0', agenda_faixas: '{quebrado' }[k] || ''));
  assert(c.duracaoMin === 30, `duração ${c.duracaoMin} — zero faria laço infinito no cálculo`);
  assert(c.faixas === null, 'JSON quebrado virou faixa');
});

t('D1. o calculo REPROVA se a antecedencia for ignorada', () => {
  // A prova de que A3 mede alguma coisa: sem antecedência, as 09:00 voltam.
  const s = proximosHorarios({ faixas: FAIXAS, agora: SEXTA_8H, antecedenciaMin: 0, maxSlots: 20 });
  assert(s.includes('2026-09-18T09:00'), 'com antecedência zero as 9h deveriam voltar');
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
