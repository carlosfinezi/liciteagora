/**
 * Horário de atendimento da IA.
 *
 * ── O problema ─────────────────────────────────────────────────────────────
 *
 * Até 2026-09-17 a resposta automática não tinha noção de expediente: às três da
 * manhã de domingo a IA respondia com o mesmo tom de terça às dez, prometendo
 * retorno que ninguém daria. Quem escreve de madrugada não espera atendimento —
 * espera saber que amanhã alguém responde.
 *
 * ── Por que o fuso vem escrito, e não do processo ──────────────────────────
 *
 * O banco grava em UTC e o servidor pode subir com TZ diferente do escritório.
 * Ler `new Date().getHours()` funcionaria hoje e passaria a fechar a empresa
 * três horas mais cedo no dia em que a unidade systemd ganhasse `TZ=UTC` —
 * silenciosamente, sem erro em lugar nenhum. Aqui a hora é sempre extraída em
 * `America/Sao_Paulo` via `Intl`, que é a única leitura que não depende do
 * ambiente.
 *
 * ── Formato da configuração ────────────────────────────────────────────────
 *
 *   whatsapp_horario_ativo    '1' | '0'   (nasce '0': ligar é decisão)
 *   whatsapp_horario_faixas   JSON: { "seg": ["08:00","18:00"], "dom": null, … }
 *   whatsapp_horario_msg      texto enviado fora do expediente
 *
 * Dia sem faixa (null ou ausente) é dia fechado. Faixa que termina antes de
 * começar ("22:00"–"06:00") atravessa a meia-noite e é tratada como tal: é o
 * plantão de quem atende à noite, e recusar seria obrigar a mentir o horário.
 */

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const FUSO = 'America/Sao_Paulo';

/** Minutos desde a meia-noite, ou null se o texto não for HH:MM válido. */
function minutos(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Dia da semana e minuto do dia, no fuso do escritório.
 * `agora` é opcional — passar um Date fixo é o que torna isto testável.
 */
function momento(agora = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(agora).map(x => [x.type, x.value]));
  const idx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  // '24' aparece à meia-noite em algumas versões do ICU com hour12:false.
  const hora = Number(p.hour) % 24;
  return { dia: DIAS[idx], minuto: hora * 60 + Number(p.minute) };
}

/**
 * Está dentro do expediente?
 *
 * Responde `true` também quando a configuração é inválida ou está vazia. Isso é
 * deliberado: o horário é uma porta que CALA a IA, e uma porta que fecha sozinha
 * por causa de um JSON quebrado deixaria o atendimento mudo sem ninguém
 * entender por quê. Na dúvida, atende.
 */
function dentroDoExpediente(faixas, agora = new Date()) {
  if (!faixas || typeof faixas !== 'object') return true;

  // Agenda sem NENHUM dia aberto também atende. "Fechado a semana inteira" não
  // é configuração de expediente: quem quer a IA calada o tempo todo desliga a
  // IA, ou desliga o horário. Um objeto vazio, ou com os sete dias em branco, é
  // sintoma de gravação incompleta — e a leitura segura disso é atender, não
  // emudecer o atendimento para sempre sem nenhum aviso.
  const algumAberto = DIAS.some((d) => {
    const f = faixas[d];
    return Array.isArray(f) && minutos(f[0]) !== null && minutos(f[1]) !== null;
  });
  if (!algumAberto) return true;

  const { dia, minuto } = momento(agora);

  const hoje = faixas[dia];
  if (Array.isArray(hoje)) {
    const de = minutos(hoje[0]), ate = minutos(hoje[1]);
    if (de !== null && ate !== null) {
      if (de <= ate) { if (minuto >= de && minuto < ate) return true; }
      // Faixa que vira o dia: vale do início até a meia-noite.
      else if (minuto >= de) return true;
    }
  }

  // A madrugada de hoje pode pertencer à faixa de ONTEM que atravessou a
  // meia-noite. Sem isto, o plantão das 22h às 6h fecharia à meia-noite em
  // ponto, no meio do turno.
  const ontem = faixas[DIAS[(DIAS.indexOf(dia) + 6) % 7]];
  if (Array.isArray(ontem)) {
    const de = minutos(ontem[0]), ate = minutos(ontem[1]);
    if (de !== null && ate !== null && de > ate && minuto < ate) return true;
  }
  return false;
}

/** Lê a configuração do tenant. `cfg` é o getConfigValue do config-helpers. */
function lerHorario(cfg) {
  let faixas = null;
  try { faixas = JSON.parse(cfg('whatsapp_horario_faixas') || 'null'); } catch (_) { faixas = null; }
  return {
    ativo: cfg('whatsapp_horario_ativo') === '1',
    faixas: (faixas && typeof faixas === 'object') ? faixas : null,
    mensagem: String(cfg('whatsapp_horario_msg') || '').trim(),
  };
}

/**
 * A pergunta que o webhook faz: devo calar a IA agora, e com que aviso?
 *
 * Devolve `null` quando o atendimento segue normal. Devolve `{ mensagem }`
 * quando está fora do expediente — com a mensagem vazia quando não há nada
 * configurado para dizer, caso em que o webhook apenas cala.
 */
function foraDoExpediente(cfg, agora = new Date()) {
  const h = lerHorario(cfg);
  if (!h.ativo || !h.faixas) return null;
  if (dentroDoExpediente(h.faixas, agora)) return null;
  return { mensagem: h.mensagem };
}

module.exports = { DIAS, FUSO, minutos, momento, dentroDoExpediente, lerHorario, foraDoExpediente };
