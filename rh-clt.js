/**
 * rh-clt.js — as regras que fazem o cadastro de funcionários valer alguma coisa.
 *
 * O módulo de RH era CRUD puro: aceitava CPF inválido, admissão no futuro,
 * jornada de 60h, férias de 45 dias e ponto batido durante as próprias férias.
 * Nada disso é preciosismo — férias não concedidas no prazo viram pagamento em
 * DOBRO (CLT art. 137), e ninguém descobre isso olhando uma lista de nomes.
 *
 * Cada regra carrega o artigo que a sustenta. Onde a lei admite exceção (piso
 * de categoria, acordo coletivo, jornada especial), a regra vira AVISO e não
 * erro: o sistema não pode impedir o que a convenção coletiva permite.
 */

// Erro bloqueia; aviso informa e deixa passar.
const erro = (codigo, mensagem, extra = {}) => ({ nivel: 'erro', codigo, mensagem, ...extra });
const aviso = (codigo, mensagem, extra = {}) => ({ nivel: 'aviso', codigo, mensagem, ...extra });

const DIA = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const dt = (s) => (s ? new Date(String(s).slice(0, 10) + 'T12:00:00Z') : null);
const diasEntre = (a, b) => Math.round((dt(b) - dt(a)) / DIA) + 1;
const somaDias = (s, n) => iso(new Date(dt(s).getTime() + n * DIA));
/**
 * Data de aniversário do contrato: mesmo dia, n meses depois.
 *
 * Deixa o calendário transbordar de propósito. Quem foi admitido em 29/02 não
 * tem aniversário em ano comum, e o transbordo leva a 01/03 — que é o dia certo
 * para "o dia anterior" fechar o período em 28/02. Prender no último dia do mês
 * (o que eu fazia antes) roubava um dia do período aquisitivo dessas pessoas.
 */
const somaMeses = (s, n) => {
  const d = dt(s);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate(), 12)));
};
const hojeISO = () => iso(new Date());

// ==================== CPF ====================

/**
 * Dígitos verificadores do CPF. A coluna é UNIQUE, o que só impede repetir a
 * mesma string: "111.111.111-11" e "11111111111" conviviam numerando a mesma
 * pessoa duas vezes, e um CPF digitado errado só aparecia no eSocial.
 */
function cpfValido(cpf) {
  const d = String(cpf || '').replace(/\D/g, '');
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;   // 000... a 999... passam no cálculo
  for (const [ate, pos] of [[9, 10], [10, 11]]) {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * (pos - i);
    const resto = (soma * 10) % 11 % 10;
    if (resto !== Number(d[ate])) return false;
  }
  return true;
}

const cpfLimpo = (cpf) => String(cpf || '').replace(/\D/g, '');

// ==================== CADASTRO ====================

const IDADE_MINIMA_APRENDIZ = 14;   // CF art. 7º XXXIII
const IDADE_MINIMA_GERAL = 16;
const IDADE_MAXIMA_APRENDIZ = 24;   // CLT art. 428 (sem limite para PcD)
const JORNADA_MAXIMA = 44;          // CF art. 7º XIII
const JORNADA_ESTAGIO = 30;         // Lei 11.788 art. 10 II
const JORNADA_APRENDIZ = 30;        // CLT art. 432 (6h/dia; 8h se ensino médio concluído)

function idadeEm(nascimento, data) {
  if (!nascimento || !data) return null;
  const n = dt(nascimento), d = dt(data);
  let anos = d.getUTCFullYear() - n.getUTCFullYear();
  const antes = (d.getUTCMonth() < n.getUTCMonth())
    || (d.getUTCMonth() === n.getUTCMonth() && d.getUTCDate() < n.getUTCDate());
  return antes ? anos - 1 : anos;
}

/**
 * @param {object} opts.salarioMinimo  piso nacional vigente; sem ele a regra
 *   de salário é pulada em vez de chutar um valor que envelhece sozinho.
 */
function validarFuncionario(db, dados, opts = {}) {
  const p = [];
  const hoje = opts.hoje || hojeISO();
  const tipo = dados.tipoContrato || 'CLT';

  if (dados.cpf != null && String(dados.cpf).trim() !== '' && !cpfValido(dados.cpf)) {
    p.push(erro('cpf_invalido', 'CPF inválido — confira os dígitos'));
  }

  // CPF duplicado com máscara diferente escapava do UNIQUE.
  if (dados.cpf && cpfValido(dados.cpf) && db) {
    const limpo = cpfLimpo(dados.cpf);
    const outro = db.prepare(`
      SELECT id, nome FROM funcionarios
      WHERE REPLACE(REPLACE(REPLACE(COALESCE(cpf,''),'.',''),'-',''),' ','') = ?
        AND id <> ?`).get(limpo, opts.id || -1);
    if (outro) p.push(erro('cpf_duplicado', `CPF já cadastrado para ${outro.nome}`, { funcionarioId: outro.id }));
  }

  if (dados.dataAdmissao) {
    if (dados.dataAdmissao > hoje) {
      p.push(aviso('admissao_futura', 'Data de admissão no futuro — confirme se é uma contratação já assinada'));
    }
    if (dados.dataNascimento && dados.dataNascimento >= dados.dataAdmissao) {
      p.push(erro('nascimento_apos_admissao', 'Data de nascimento posterior (ou igual) à admissão'));
    }
    if (dados.dataDemissao && dados.dataDemissao < dados.dataAdmissao) {
      p.push(erro('demissao_antes_admissao', 'Data de demissão anterior à admissão'));
    }
  }

  const idade = idadeEm(dados.dataNascimento, dados.dataAdmissao || hoje);
  if (idade != null) {
    if (idade < IDADE_MINIMA_APRENDIZ) {
      p.push(erro('idade_proibida', `Trabalho proibido abaixo de ${IDADE_MINIMA_APRENDIZ} anos (CF art. 7º XXXIII)`));
    } else if (idade < IDADE_MINIMA_GERAL && tipo !== 'jovem-aprendiz') {
      p.push(erro('idade_so_aprendiz',
        `Entre ${IDADE_MINIMA_APRENDIZ} e ${IDADE_MINIMA_GERAL - 1} anos só como jovem-aprendiz (CF art. 7º XXXIII)`));
    } else if (idade < 18) {
      p.push(aviso('menor_de_18',
        'Menor de 18: vedado trabalho noturno, insalubre ou perigoso (CLT art. 404 e CF art. 7º XXXIII)'));
    }
    if (tipo === 'jovem-aprendiz' && idade > IDADE_MAXIMA_APRENDIZ) {
      p.push(aviso('aprendiz_idade',
        `Aprendizagem vai até ${IDADE_MAXIMA_APRENDIZ} anos, salvo aprendiz com deficiência (CLT art. 428 §5º)`));
    }
  }

  const jornada = Number(dados.jornadaSemanalHoras);
  if (jornada > 0) {
    if (jornada > JORNADA_MAXIMA) {
      p.push(erro('jornada_acima_do_limite',
        `Jornada semanal acima de ${JORNADA_MAXIMA}h (CF art. 7º XIII). Horas extras se registram no ponto, não no contrato`));
    }
    if (tipo === 'estagio' && jornada > JORNADA_ESTAGIO) {
      p.push(erro('jornada_estagio', `Estágio: máximo ${JORNADA_ESTAGIO}h semanais (Lei 11.788 art. 10 II)`));
    }
    if (tipo === 'jovem-aprendiz' && jornada > JORNADA_APRENDIZ) {
      p.push(aviso('jornada_aprendiz',
        `Aprendiz: 6h diárias, salvo ensino médio concluído (CLT art. 432)`));
    }
  }

  // Piso nacional só vale para contrato de emprego, e proporcional à jornada.
  const minimo = Number(opts.salarioMinimo) || 0;
  const salario = Number(dados.salario) || 0;
  if (minimo > 0 && salario > 0 && ['CLT', 'jovem-aprendiz'].includes(tipo) && jornada > 0) {
    const proporcional = minimo * Math.min(jornada, JORNADA_MAXIMA) / JORNADA_MAXIMA;
    if (salario < proporcional - 0.01) {
      p.push(aviso('salario_abaixo_do_minimo',
        `Salário abaixo do mínimo proporcional à jornada (R$ ${proporcional.toFixed(2)}). `
        + 'Verifique o piso da categoria antes de gravar'));
    }
  }

  return p;
}

// ==================== FÉRIAS ====================

/**
 * Dias de férias conforme faltas injustificadas no período aquisitivo.
 * CLT art. 130 — a escala é essa, não é proporcional.
 */
function diasDeDireito(faltasInjustificadas = 0) {
  const f = Number(faltasInjustificadas) || 0;
  if (f <= 5) return 30;
  if (f <= 14) return 24;
  if (f <= 23) return 18;
  if (f <= 32) return 12;
  return 0;   // art. 130 §único: mais de 32 faltas, sem direito
}

/**
 * Períodos aquisitivos de 12 meses encadeados a partir da admissão.
 * O sistema pedia que o usuário digitasse as duas datas — quem digita erra, e
 * o período errado desloca todo o cálculo de vencimento.
 */
function periodosAquisitivos(dataAdmissao, ate) {
  if (!dataAdmissao) return [];
  const limite = ate || hojeISO();
  const periodos = [];
  let ini = String(dataAdmissao).slice(0, 10);
  // Um a mais que o vencido: o período em curso também precisa aparecer.
  for (let i = 0; i < 60; i++) {
    const fim = somaDias(somaMeses(ini, 12), -1);
    // CLT art. 134: os 12 meses de concessão correm a partir do dia seguinte ao
    // fim do aquisitivo. Contar a partir do próprio fim encurtava o prazo em um
    // dia e antecipava o "em dobro".
    const concessivoIni = somaDias(fim, 1);
    periodos.push({
      ini,
      fim,
      completo: fim <= limite,
      concessivoIni,
      concessivoFim: somaDias(somaMeses(concessivoIni, 12), -1),
    });
    if (ini > limite) break;
    ini = somaDias(fim, 1);
  }
  return periodos;
}

/**
 * Situação de férias de um funcionário: o que venceu, o que está vencendo e o
 * que já virou passivo em dobro.
 */
function situacaoFerias(db, funcionarioId, opts = {}) {
  const hoje = opts.hoje || hojeISO();
  const f = db.prepare('SELECT * FROM funcionarios WHERE id = ?').get(funcionarioId);
  if (!f) return null;

  const gozos = db.prepare(`SELECT * FROM funcionarios_ferias
    WHERE funcionarioId = ? AND status <> 'cancelada'
    ORDER BY periodoAquisitivoIni, dataInicio`).all(funcionarioId);

  const ate = f.dataDemissao && f.dataDemissao < hoje ? f.dataDemissao : hoje;
  const periodos = periodosAquisitivos(f.dataAdmissao, ate)
    .filter((p) => p.ini <= ate)
    .map((p) => {
      const doPeriodo = gozos.filter((g) => g.periodoAquisitivoIni === p.ini);
      const gozados = doPeriodo.reduce((s, g) => s + (Number(g.dias) || 0), 0);
      const abono = doPeriodo.reduce((s, g) => s + (Number(g.diasAbono) || 0), 0);
      const faltas = contarFaltasInjustificadas(db, funcionarioId, p.ini, p.fim);
      const direito = p.completo ? diasDeDireito(faltas) : 0;
      const saldo = Math.max(0, direito - gozados - abono);

      // Só vence quem completou o aquisitivo; e o dobro só corre depois do
      // concessivo inteiro, não no dia seguinte ao aquisitivo.
      const vencido = p.completo && saldo > 0 && hoje > p.concessivoFim;
      const diasParaVencer = p.completo ? Math.round((dt(p.concessivoFim) - dt(hoje)) / DIA) : null;

      return { ...p, faltasInjustificadas: faltas, direito, gozados, abono, saldo, vencido, diasParaVencer };
    });

  const emDobro = periodos.filter((p) => p.vencido);
  const aVencer = periodos.filter((p) => !p.vencido && p.saldo > 0 && p.diasParaVencer != null && p.diasParaVencer <= 90);

  return {
    funcionarioId,
    nome: f.nome,
    dataAdmissao: f.dataAdmissao,
    periodos,
    saldoTotal: periodos.reduce((s, p) => s + p.saldo, 0),
    // Dinheiro: cada dia vencido custa o dobro (art. 137).
    diasEmDobro: emDobro.reduce((s, p) => s + p.saldo, 0),
    custoDobroEstimado: emDobro.reduce((s, p) => s + p.saldo, 0) * (Number(f.salario) || 0) / 30,
    aVencer,
  };
}

function contarFaltasInjustificadas(db, funcionarioId, ini, fim) {
  try {
    return db.prepare(`SELECT COUNT(*) n FROM funcionarios_ponto
      WHERE funcionarioId = ? AND data >= ? AND data <= ? AND tipo = 'falta'`).get(funcionarioId, ini, fim).n;
  } catch { return 0; }
}

const MAX_PERIODOS_FRACIONADOS = 3;   // CLT art. 134 §1º (reforma 2017)
const MIN_PERIODO_MAIOR = 14;
const MIN_PERIODO_MENOR = 5;

function validarFerias(db, funcionarioId, dados, opts = {}) {
  const p = [];
  const hoje = opts.hoje || hojeISO();
  const f = db.prepare('SELECT * FROM funcionarios WHERE id = ?').get(funcionarioId);
  if (!f) return [erro('funcionario_inexistente', 'Funcionário não encontrado')];

  const dias = Number(dados.dias) || 0;
  const abono = Number(dados.diasAbono) || 0;
  const ini = dados.dataInicio, fim = dados.dataFim;

  if (ini && fim && fim < ini) p.push(erro('periodo_invertido', 'Fim das férias antes do início'));

  if (ini && ini < f.dataAdmissao) {
    p.push(erro('ferias_antes_da_admissao', 'Férias antes da data de admissão'));
  }

  // O período aquisitivo tem que ser um dos períodos reais do contrato. A lista
  // vai além de hoje só para reconhecer um período futuro digitado — mas o
  // "completo" tem que ser medido contra hoje, senão marcar férias de período
  // que ainda não venceu passaria batido.
  const periodos = periodosAquisitivos(f.dataAdmissao, somaMeses(hoje, 24))
    .map((x) => ({ ...x, completo: x.fim <= hoje }));
  const doContrato = periodos.find((x) => x.ini === dados.periodoAquisitivoIni);
  if (dados.periodoAquisitivoIni && !doContrato) {
    p.push(erro('aquisitivo_inexistente',
      'Período aquisitivo não corresponde a nenhum período do contrato (contam-se 12 meses a partir da admissão)'));
  }
  if (doContrato && !doContrato.completo) {
    p.push(erro('aquisitivo_incompleto',
      `Período aquisitivo só se completa em ${doContrato.fim} — não há direito adquirido antes disso (CLT art. 130)`));
  }

  const outros = db.prepare(`SELECT * FROM funcionarios_ferias
    WHERE funcionarioId = ? AND status <> 'cancelada' AND id <> ?`).all(funcionarioId, opts.feriasId || -1);

  // ---- limite de dias do período aquisitivo ----
  if (doContrato && doContrato.completo) {
    const faltas = contarFaltasInjustificadas(db, funcionarioId, doContrato.ini, doContrato.fim);
    const direito = diasDeDireito(faltas);
    const jaUsados = outros.filter((g) => g.periodoAquisitivoIni === doContrato.ini)
      .reduce((s, g) => s + (Number(g.dias) || 0) + (Number(g.diasAbono) || 0), 0);

    if (direito === 0) {
      p.push(erro('sem_direito_por_faltas',
        `${faltas} faltas injustificadas no período aquisitivo: sem direito a férias (CLT art. 130 §único)`));
    } else if (jaUsados + dias + abono > direito) {
      p.push(erro('excede_direito',
        `Total de ${jaUsados + dias + abono} dias excede os ${direito} de direito`
        + (faltas > 5 ? ` (reduzidos por ${faltas} faltas injustificadas — CLT art. 130)` : '')));
    }

    // ---- abono pecuniário: até 1/3 (CLT art. 143) ----
    const tetoAbono = Math.floor(direito / 3);
    const abonoTotal = outros.filter((g) => g.periodoAquisitivoIni === doContrato.ini)
      .reduce((s, g) => s + (Number(g.diasAbono) || 0), 0) + abono;
    if (abonoTotal > tetoAbono) {
      p.push(erro('abono_acima_do_terco',
        `Abono pecuniário limitado a ${tetoAbono} dias (1/3 de ${direito} — CLT art. 143)`));
    }

    // ---- fracionamento (CLT art. 134 §1º) ----
    const doMesmo = outros.filter((g) => g.periodoAquisitivoIni === doContrato.ini && Number(g.dias) > 0);
    if (dias > 0) {
      const partes = [...doMesmo.map((g) => Number(g.dias)), dias];
      if (partes.length > MAX_PERIODOS_FRACIONADOS) {
        p.push(erro('fracionamento_excedido',
          `Férias podem ser fracionadas em até ${MAX_PERIODOS_FRACIONADOS} períodos (CLT art. 134 §1º)`));
      }
      if (partes.length > 1) {
        if (!partes.some((d) => d >= MIN_PERIODO_MAIOR)) {
          p.push(erro('sem_periodo_de_14',
            `Ao fracionar, um dos períodos precisa ter ao menos ${MIN_PERIODO_MAIOR} dias corridos (CLT art. 134 §1º)`));
        }
        if (dias < MIN_PERIODO_MENOR) {
          p.push(erro('periodo_menor_que_5',
            `Nenhum período fracionado pode ter menos de ${MIN_PERIODO_MENOR} dias (CLT art. 134 §1º)`));
        }
      }
    }

    // ---- concessivo vencido ----
    if (hoje > doContrato.concessivoFim) {
      p.push(aviso('concessivo_vencido',
        `Período concessivo terminou em ${doContrato.concessivoFim}: estas férias são devidas em DOBRO (CLT art. 137)`));
    }
  }

  // ---- sobreposição com outro gozo ----
  if (ini && fim) {
    const conflito = outros.find((g) => g.dataInicio && g.dataFim && ini <= g.dataFim && fim >= g.dataInicio);
    if (conflito) {
      p.push(erro('ferias_sobrepostas',
        `Sobrepõe férias já registradas de ${conflito.dataInicio} a ${conflito.dataFim}`));
    }

    if (dias > 0 && diasEntre(ini, fim) !== dias) {
      p.push(aviso('dias_divergem',
        `Intervalo de ${diasEntre(ini, fim)} dias corridos não bate com os ${dias} dias informados`));
    }

    // ---- não pode começar 2 dias antes de feriado ou DSR (art. 134 §3º) ----
    const impedimento = inicioImpedido(db, ini);
    if (impedimento) p.push(aviso('inicio_proximo_de_descanso', impedimento));
  }

  return p;
}

/**
 * CLT art. 134 §3º: as férias não podem começar nos 2 dias que antecedem
 * feriado ou dia de repouso semanal. Assume DSR no domingo, que é a regra
 * geral — escala 12x36 e comércio têm acordo próprio, por isso é aviso.
 */
function inicioImpedido(db, dataInicio) {
  const d = dt(dataInicio);
  const diaSemana = d.getUTCDay();   // 0 = domingo
  if (diaSemana === 5 || diaSemana === 6 || diaSemana === 0) {
    const nomes = { 5: 'sexta-feira', 6: 'sábado', 0: 'domingo' };
    return `Início numa ${nomes[diaSemana]}: férias não podem começar nos 2 dias anteriores ao repouso semanal (CLT art. 134 §3º)`;
  }
  try {
    const proximos = [somaDias(dataInicio, 1), somaDias(dataInicio, 2)];
    const feriado = db.prepare(
      `SELECT data, descricao FROM feriados WHERE ativo = 1 AND data IN (?, ?)`).get(...proximos);
    if (feriado) {
      return `Início a menos de 2 dias do feriado de ${feriado.data}`
        + (feriado.descricao ? ` (${feriado.descricao})` : '') + ' — CLT art. 134 §3º';
    }
  } catch { /* tenant sem tabela de feriados */ }
  return null;
}

// ==================== PONTO ====================

const INTERJORNADA_MINIMA = 11;        // CLT art. 66
const EXTRAS_MAXIMAS_DIA = 2;          // CLT art. 59
const INTERVALO_JORNADA_LONGA = 60;    // minutos, jornada > 6h (art. 71)
const INTERVALO_JORNADA_MEDIA = 15;    // minutos, jornada de 4h a 6h

const minutos = (h) => {
  if (!h) return null;
  const [a, b] = String(h).split(':').map(Number);
  return a * 60 + (b || 0);
};

/**
 * Horas trabalhadas, com virada de meia-noite.
 *
 * A conta antiga era (saída - entrada) e um Math.max(0, ...): quem entrava às
 * 22h e saía às 6h fechava o dia com ZERO hora, sem nenhum aviso. Turno noturno
 * é comum e o erro é silencioso — o pior tipo.
 */
function calcularHoras(p) {
  const ent = minutos(p.horaEntrada), sai = minutos(p.horaSaida);
  if (ent == null || sai == null) return 0;
  let total = sai - ent;
  if (total < 0) total += 24 * 60;   // atravessou a meia-noite

  const si = minutos(p.horaSaidaAlmoco), vo = minutos(p.horaVoltaAlmoco);
  if (si != null && vo != null) {
    let intervalo = vo - si;
    if (intervalo < 0) intervalo += 24 * 60;
    total -= intervalo;
  }
  return Math.max(0, Math.round((total / 60) * 100) / 100);
}

function minutosDeIntervalo(p) {
  const si = minutos(p.horaSaidaAlmoco), vo = minutos(p.horaVoltaAlmoco);
  if (si == null || vo == null) return null;
  let m = vo - si;
  if (m < 0) m += 24 * 60;
  return m;
}

function validarPonto(db, funcionarioId, dados, opts = {}) {
  const p = [];
  const hoje = opts.hoje || hojeISO();
  const f = db.prepare('SELECT * FROM funcionarios WHERE id = ?').get(funcionarioId);
  if (!f) return [erro('funcionario_inexistente', 'Funcionário não encontrado')];

  const data = dados.data;
  if (!data) return [erro('data_obrigatoria', 'Data obrigatória')];

  if (data > hoje) p.push(erro('ponto_futuro', 'Não é possível registrar ponto em data futura'));
  if (data < f.dataAdmissao) {
    p.push(erro('ponto_antes_da_admissao', `Data anterior à admissão (${f.dataAdmissao})`));
  }
  if (f.dataDemissao && data > f.dataDemissao) {
    p.push(erro('ponto_apos_demissao', `Data posterior à demissão (${f.dataDemissao})`));
  }

  const horas = calcularHoras(dados);
  const tipo = dados.tipo || 'normal';

  // ---- contradição com férias e atestado ----
  if (tipo === 'normal' && horas > 0) {
    const ferias = db.prepare(`SELECT dataInicio, dataFim FROM funcionarios_ferias
      WHERE funcionarioId = ? AND status IN ('aprovada','em-curso','concluida')
        AND dataInicio <= ? AND dataFim >= ?`).get(funcionarioId, data, data);
    if (ferias) {
      p.push(erro('ponto_durante_ferias',
        `Funcionário em férias de ${ferias.dataInicio} a ${ferias.dataFim} — trabalho em férias é irregular (CLT art. 138)`));
    }
    let atestado = null;
    try {
      atestado = db.prepare(`SELECT dataInicio, dataFim FROM funcionarios_atestados
        WHERE funcionarioId = ? AND dataInicio <= ? AND dataFim >= ?`).get(funcionarioId, data, data);
    } catch { /* tenant sem a tabela */ }
    if (atestado) {
      p.push(aviso('ponto_durante_atestado',
        `Há atestado cobrindo ${data} (${atestado.dataInicio} a ${atestado.dataFim}) — confirme qual dos dois vale`));
    }
  }

  // ---- intervalo intrajornada (art. 71) ----
  const intervalo = minutosDeIntervalo(dados);
  const brutas = horas + (intervalo || 0) / 60;
  if (brutas > 6 && (intervalo == null || intervalo < INTERVALO_JORNADA_LONGA)) {
    p.push(aviso('intervalo_insuficiente',
      `Jornada acima de 6h exige no mínimo 1h de intervalo (CLT art. 71). `
      + (intervalo == null ? 'Nenhum intervalo registrado' : `Registrado: ${intervalo} min`)
      + ' — o tempo suprimido é devido como hora extra com 50%'));
  } else if (brutas > 4 && brutas <= 6 && intervalo != null && intervalo < INTERVALO_JORNADA_MEDIA) {
    p.push(aviso('intervalo_curto',
      `Jornada de 4h a 6h exige 15 min de intervalo (CLT art. 71 §1º). Registrado: ${intervalo} min`));
  }

  // ---- interjornada de 11h (art. 66) ----
  if (dados.horaEntrada) {
    const anterior = db.prepare(`SELECT data, horaSaida FROM funcionarios_ponto
      WHERE funcionarioId = ? AND data < ? AND horaSaida IS NOT NULL
      ORDER BY data DESC LIMIT 1`).get(funcionarioId, data);
    if (anterior && anterior.horaSaida) {
      const fimAnterior = dt(anterior.data).getTime() + minutos(anterior.horaSaida) * 60000;
      const inicioHoje = dt(data).getTime() + minutos(dados.horaEntrada) * 60000;
      const descanso = (inicioHoje - fimAnterior) / 3600000;
      if (descanso >= 0 && descanso < INTERJORNADA_MINIMA) {
        p.push(aviso('interjornada_curta',
          `Apenas ${descanso.toFixed(1)}h desde a saída de ${anterior.data} — mínimo de ${INTERJORNADA_MINIMA}h (CLT art. 66)`));
      }
    }
  }

  // ---- horas extras (art. 59) ----
  const jornadaDiaria = (Number(f.jornadaSemanalHoras) || JORNADA_MAXIMA) / 6;
  const extras = horas - jornadaDiaria;
  if (extras > EXTRAS_MAXIMAS_DIA + 0.01) {
    p.push(aviso('extras_acima_do_limite',
      `${extras.toFixed(1)}h extras: acima das 2h diárias do acordo de prorrogação (CLT art. 59)`));
  }

  if (horas > 24) p.push(erro('horas_impossiveis', 'Mais de 24 horas num único dia'));

  return p;
}

// ==================== ATESTADOS ====================

const DIAS_EMPRESA = 15;   // Lei 8.213 art. 60 §3º: do 16º dia em diante é INSS

function validarAtestado(db, funcionarioId, dados, opts = {}) {
  const p = [];
  const f = db.prepare('SELECT * FROM funcionarios WHERE id = ?').get(funcionarioId);
  if (!f) return [erro('funcionario_inexistente', 'Funcionário não encontrado')];

  const { dataInicio, dataFim } = dados;
  if (!dataInicio || !dataFim) return [erro('datas_obrigatorias', 'Início e fim obrigatórios')];
  if (dataFim < dataInicio) return [erro('periodo_invertido', 'Fim do afastamento antes do início')];

  if (dataInicio < f.dataAdmissao) {
    p.push(erro('atestado_antes_da_admissao', `Início anterior à admissão (${f.dataAdmissao})`));
  }

  const dias = diasEntre(dataInicio, dataFim);

  const outros = db.prepare(`SELECT * FROM funcionarios_atestados
    WHERE funcionarioId = ? AND id <> ?`).all(funcionarioId, opts.atestadoId || -1);

  const sobreposto = outros.find((a) => dataInicio <= a.dataFim && dataFim >= a.dataInicio);
  if (sobreposto) {
    p.push(erro('atestado_sobreposto',
      `Sobrepõe atestado de ${sobreposto.dataInicio} a ${sobreposto.dataFim}`));
  }

  // Do 16º dia o benefício é do INSS; e atestados do mesmo CID em até 60 dias
  // somam para esse cálculo (Lei 8.213 art. 75 §3º do decreto 3.048).
  const mesmoCid = dados.cid
    ? outros.filter((a) => a.cid && a.cid === dados.cid
        && Math.abs((dt(dataInicio) - dt(a.dataFim)) / DIA) <= 60)
    : [];
  const acumulado = dias + mesmoCid.reduce((s, a) => s + (Number(a.dias) || 0), 0);

  if (acumulado > DIAS_EMPRESA) {
    p.push(aviso('encaminhar_inss',
      `${acumulado} dias de afastamento${mesmoCid.length ? ' (somando atestados do mesmo CID em 60 dias)' : ''}: `
      + `a partir do 16º dia o pagamento é do INSS — encaminhe o auxílio-doença (Lei 8.213 art. 60 §3º)`));
  }

  const durante = db.prepare(`SELECT dataInicio, dataFim FROM funcionarios_ferias
    WHERE funcionarioId = ? AND status IN ('aprovada','em-curso','concluida')
      AND dataInicio <= ? AND dataFim >= ?`).get(funcionarioId, dataFim, dataInicio);
  if (durante) {
    p.push(aviso('atestado_durante_ferias',
      `Coincide com férias de ${durante.dataInicio} a ${durante.dataFim} — doença nas férias interrompe o gozo `
      + 'e os dias devem ser reprogramados'));
  }

  return p;
}

// ==================== PAINEL ====================

/**
 * O que um gestor precisa ver sem procurar. Só entra o que tem consequência:
 * passivo de férias, contratos de experiência a vencer, absenteísmo.
 */
function alertasRH(db, opts = {}) {
  const hoje = opts.hoje || hojeISO();
  const ativos = db.prepare('SELECT * FROM funcionarios WHERE ativo = 1').all();

  const feriasVencidas = [];
  const feriasAVencer = [];
  for (const f of ativos) {
    const s = situacaoFerias(db, f.id, { hoje });
    if (!s) continue;
    if (s.diasEmDobro > 0) {
      feriasVencidas.push({
        funcionarioId: f.id, nome: f.nome, dias: s.diasEmDobro,
        custoDobroEstimado: s.custoDobroEstimado,
        desde: s.periodos.filter((p) => p.vencido).map((p) => p.concessivoFim).sort()[0],
      });
    }
    for (const p of s.aVencer) {
      feriasAVencer.push({ funcionarioId: f.id, nome: f.nome, dias: p.saldo, venceEm: p.concessivoFim, emDias: p.diasParaVencer });
    }
  }

  // Contrato de experiência: 90 dias no total, prorrogável uma vez (CLT art. 445
  // §único). Passar disso converte em prazo indeterminado sem ninguém decidir.
  const experiencia = ativos
    .filter((f) => f.tipoContrato === 'CLT')
    .map((f) => ({ f, diasDeCasa: Math.round((dt(hoje) - dt(f.dataAdmissao)) / DIA) }))
    .filter((x) => x.diasDeCasa >= 60 && x.diasDeCasa <= 95)
    .map((x) => ({
      funcionarioId: x.f.id, nome: x.f.nome, dataAdmissao: x.f.dataAdmissao,
      diasDeCasa: x.diasDeCasa, limite: somaDias(x.f.dataAdmissao, 89),
    }));

  const inicioMes = hoje.slice(0, 8) + '01';
  let absenteismo = [];
  try {
    absenteismo = db.prepare(`
      SELECT f.id AS funcionarioId, f.nome,
             SUM(CASE WHEN p.tipo = 'falta' THEN 1 ELSE 0 END) AS faltas
      FROM funcionarios f
      JOIN funcionarios_ponto p ON p.funcionarioId = f.id
      WHERE f.ativo = 1 AND p.data >= ? AND p.data <= ?
      GROUP BY f.id, f.nome
      HAVING faltas > 0
      ORDER BY faltas DESC`).all(inicioMes, hoje);
  } catch { /* sem ponto registrado */ }

  const semCpf = ativos.filter((f) => !f.cpf || !cpfValido(f.cpf))
    .map((f) => ({ funcionarioId: f.id, nome: f.nome, cpf: f.cpf || null }));

  const aniversariantes = ativos
    .filter((f) => f.dataNascimento && f.dataNascimento.slice(5, 7) === hoje.slice(5, 7))
    .map((f) => ({ funcionarioId: f.id, nome: f.nome, dia: f.dataNascimento.slice(8, 10) }))
    .sort((a, b) => a.dia.localeCompare(b.dia));

  return {
    feriasVencidas: feriasVencidas.sort((a, b) => b.dias - a.dias),
    feriasAVencer: feriasAVencer.sort((a, b) => a.emDias - b.emDias),
    passivoFeriasEstimado: feriasVencidas.reduce((s, x) => s + x.custoDobroEstimado, 0),
    experienciaAVencer: experiencia,
    absenteismoMes: absenteismo,
    cadastroIncompleto: semCpf,
    aniversariantes,
  };
}

module.exports = {
  cpfValido, cpfLimpo, idadeEm,
  validarFuncionario,
  diasDeDireito, periodosAquisitivos, situacaoFerias, validarFerias, inicioImpedido,
  calcularHoras, validarPonto,
  validarAtestado,
  alertasRH,
};
