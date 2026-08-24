/**
 * Regras CLT no cadastro de funcionários.
 *
 * O módulo era CRUD puro: aceitava CPF inválido, jornada de 60h, férias de 45
 * dias e ponto batido durante as próprias férias. O caso caro é o art. 137 —
 * férias não concedidas no período concessivo são devidas em DOBRO, e nada no
 * sistema avisava.
 *
 * Cada teste amarra um artigo. Se a regra mudar (e a CLT muda), o teste diz
 * qual artigo estava sendo seguido.
 */
const fs = require('fs');
const Database = require('better-sqlite3');
const clt = require('../rh-clt');

const DB = '/tmp/vp-rh.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.exec(fs.readFileSync('/tmp/vp-rh-schema.sql', 'utf8'));

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const perto = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) < tol;

const tem = (probs, codigo) => probs.some((p) => p.codigo === codigo);
const naoTem = (probs, codigo) => !tem(probs, codigo);
const codigos = (probs) => probs.map((p) => p.codigo).join(', ') || '(nenhum)';

function limpar() {
  db.exec(`DELETE FROM funcionarios_ponto; DELETE FROM funcionarios_ferias;
           DELETE FROM funcionarios_atestados; DELETE FROM funcionarios; DELETE FROM feriados;`);
}
const novoFunc = (o = {}) => db.prepare(`INSERT INTO funcionarios
  (nome, cpf, dataNascimento, dataAdmissao, dataDemissao, salario, tipoContrato, jornadaSemanalHoras, ativo)
  VALUES (@nome, @cpf, @dataNascimento, @dataAdmissao, @dataDemissao, @salario, @tipoContrato, @jornadaSemanalHoras, @ativo)`)
  .run({ nome: 'Fulano', cpf: null, dataNascimento: '1990-05-10', dataAdmissao: '2020-03-01',
         dataDemissao: null, salario: 3000, tipoContrato: 'CLT', jornadaSemanalHoras: 44, ativo: 1, ...o })
  .lastInsertRowid;

// ==================== CPF ====================
console.log('\n--- CPF ---');

t('aceita CPF válido com e sem máscara', () => {
  assert(clt.cpfValido('529.982.247-25'), 'com máscara');
  assert(clt.cpfValido('52998224725'), 'sem máscara');
});

t('recusa dígito verificador errado', () => {
  assert(!clt.cpfValido('529.982.247-26'), 'passou um DV errado');
  assert(!clt.cpfValido('12345678901'), 'passou sequência');
});

t('recusa dígitos repetidos, que passam na conta mas não existem', () => {
  for (const c of ['00000000000', '11111111111', '99999999999']) {
    assert(!clt.cpfValido(c), 'aceitou ' + c);
  }
});

t('recusa tamanho errado', () => {
  assert(!clt.cpfValido('5299822472'), '10 dígitos');
  assert(!clt.cpfValido(''), 'vazio');
  assert(!clt.cpfValido(null), 'nulo');
});

t('CPF duplicado com máscara diferente é detectado', () => {
  limpar();
  novoFunc({ nome: 'Maria', cpf: '529.982.247-25' });
  // O UNIQUE da coluna deixava passar: a string era diferente.
  const p = clt.validarFuncionario(db, { nome: 'Outro', cpf: '52998224725', dataAdmissao: '2024-01-10' });
  assert(tem(p, 'cpf_duplicado'), codigos(p));
});

t('editar o próprio registro não acusa duplicidade contra si mesmo', () => {
  limpar();
  const id = novoFunc({ nome: 'Maria', cpf: '529.982.247-25' });
  const p = clt.validarFuncionario(db, { nome: 'Maria', cpf: '529.982.247-25', dataAdmissao: '2020-03-01' }, { id });
  assert(naoTem(p, 'cpf_duplicado'), codigos(p));
});

// ==================== CADASTRO ====================
console.log('\n--- cadastro ---');

t('nascimento depois da admissão é erro', () => {
  const p = clt.validarFuncionario(db, { nome: 'X', dataNascimento: '2021-01-01', dataAdmissao: '2020-03-01' });
  assert(tem(p, 'nascimento_apos_admissao'), codigos(p));
});

t('demissão antes da admissão é erro', () => {
  const p = clt.validarFuncionario(db, { nome: 'X', dataAdmissao: '2020-03-01', dataDemissao: '2019-01-01' });
  assert(tem(p, 'demissao_antes_admissao'), codigos(p));
});

t('menor de 14 anos é proibido (CF art. 7º XXXIII)', () => {
  const p = clt.validarFuncionario(db, { nome: 'X', dataNascimento: '2013-01-01', dataAdmissao: '2026-01-01' });
  assert(tem(p, 'idade_proibida'), codigos(p));
});

t('14 a 15 anos só como jovem-aprendiz', () => {
  const dados = { nome: 'X', dataNascimento: '2011-01-01', dataAdmissao: '2026-01-01' };
  assert(tem(clt.validarFuncionario(db, dados), 'idade_so_aprendiz'), 'CLT deveria barrar');
  const aprendiz = clt.validarFuncionario(db, { ...dados, tipoContrato: 'jovem-aprendiz' });
  assert(naoTem(aprendiz, 'idade_so_aprendiz'), codigos(aprendiz));
});

t('menor de 18 passa, mas com aviso sobre trabalho noturno/perigoso', () => {
  const p = clt.validarFuncionario(db, { nome: 'X', dataNascimento: '2009-06-01', dataAdmissao: '2026-01-01' });
  assert(naoTem(p, 'idade_proibida') && naoTem(p, 'idade_so_aprendiz'), codigos(p));
  assert(tem(p, 'menor_de_18'), codigos(p));
  assert(p.find((x) => x.codigo === 'menor_de_18').nivel === 'aviso', 'deveria ser aviso');
});

t('jornada acima de 44h é erro (CF art. 7º XIII)', () => {
  const p = clt.validarFuncionario(db, { nome: 'X', dataAdmissao: '2020-01-01', jornadaSemanalHoras: 60 });
  assert(tem(p, 'jornada_acima_do_limite'), codigos(p));
});

t('44h exatas passam', () => {
  const p = clt.validarFuncionario(db, { nome: 'X', dataAdmissao: '2020-01-01', jornadaSemanalHoras: 44 });
  assert(naoTem(p, 'jornada_acima_do_limite'), codigos(p));
});

t('estágio acima de 30h é erro (Lei 11.788)', () => {
  const p = clt.validarFuncionario(db, { nome: 'X', dataAdmissao: '2020-01-01', tipoContrato: 'estagio', jornadaSemanalHoras: 40 });
  assert(tem(p, 'jornada_estagio'), codigos(p));
});

t('salário abaixo do mínimo proporcional é aviso, não bloqueio', () => {
  const p = clt.validarFuncionario(db,
    { nome: 'X', dataAdmissao: '2020-01-01', jornadaSemanalHoras: 44, salario: 900 },
    { salarioMinimo: 1518 });
  const a = p.find((x) => x.codigo === 'salario_abaixo_do_minimo');
  // Piso de categoria e acordo coletivo existem: bloquear seria errado.
  assert(a && a.nivel === 'aviso', codigos(p));
});

t('meia jornada com metade do mínimo não é acusada', () => {
  const p = clt.validarFuncionario(db,
    { nome: 'X', dataAdmissao: '2020-01-01', jornadaSemanalHoras: 22, salario: 800 },
    { salarioMinimo: 1518 });
  assert(naoTem(p, 'salario_abaixo_do_minimo'), codigos(p));
});

t('sem mínimo configurado a regra de salário não roda (o piso muda todo ano)', () => {
  const p = clt.validarFuncionario(db, { nome: 'X', dataAdmissao: '2020-01-01', jornadaSemanalHoras: 44, salario: 1 });
  assert(naoTem(p, 'salario_abaixo_do_minimo'), codigos(p));
});

// ==================== FÉRIAS: PERÍODOS ====================
console.log('\n--- férias: períodos aquisitivos ---');

t('períodos de 12 meses encadeados a partir da admissão', () => {
  const p = clt.periodosAquisitivos('2020-03-01', '2023-06-01');
  assert(p[0].ini === '2020-03-01' && p[0].fim === '2021-02-28', JSON.stringify(p[0]));
  assert(p[1].ini === '2021-03-01' && p[1].fim === '2022-02-28', JSON.stringify(p[1]));
  assert(p[2].ini === '2022-03-01' && p[2].fim === '2023-02-28', JSON.stringify(p[2]));
});

t('admissão em 29 de fevereiro não estoura o calendário', () => {
  const p = clt.periodosAquisitivos('2024-02-29', '2026-01-01');
  assert(p[0].fim === '2025-02-28', JSON.stringify(p[0]));
  // E o período seguinte começa no dia seguinte, sem buraco no calendário.
  assert(p[1].ini === '2025-03-01', JSON.stringify(p[1]));
});

t('admissão dia 31 não pula para o mês seguinte', () => {
  const p = clt.periodosAquisitivos('2020-01-31', '2022-01-01');
  assert(p[0].fim === '2021-01-30', JSON.stringify(p[0]));
});

t('período concessivo termina 12 meses depois do aquisitivo (art. 134)', () => {
  const p = clt.periodosAquisitivos('2020-03-01', '2023-01-01');
  // Aquisitivo fecha 2021-02-28; os 12 meses de concessão correm de 2021-03-01
  // a 2022-02-28.
  assert(p[0].concessivoFim === '2022-02-28', 'concessivo: ' + p[0].concessivoFim);
});

// ==================== FÉRIAS: DIREITO ====================
console.log('\n--- férias: dias de direito (art. 130) ---');

t('a escala de faltas é degrau, não proporcional', () => {
  const esperado = [[0, 30], [5, 30], [6, 24], [14, 24], [15, 18], [23, 18], [24, 12], [32, 12], [33, 0], [50, 0]];
  for (const [faltas, dias] of esperado) {
    assert(clt.diasDeDireito(faltas) === dias, `${faltas} faltas -> ${clt.diasDeDireito(faltas)}, esperado ${dias}`);
  }
});

t('faltas registradas no ponto reduzem o direito', () => {
  limpar();
  const id = novoFunc({ dataAdmissao: '2020-03-01' });
  const ins = db.prepare("INSERT INTO funcionarios_ponto (funcionarioId, data, tipo) VALUES (?, ?, 'falta')");
  for (let i = 1; i <= 8; i++) ins.run(id, `2020-06-${String(i).padStart(2, '0')}`);
  const s = clt.situacaoFerias(db, id, { hoje: '2021-06-01' });
  const primeiro = s.periodos[0];
  assert(primeiro.faltasInjustificadas === 8, 'faltas: ' + primeiro.faltasInjustificadas);
  assert(primeiro.direito === 24, 'direito: ' + primeiro.direito);
});

// ==================== FÉRIAS: SITUAÇÃO ====================
console.log('\n--- férias: saldo e vencimento ---');

t('período em curso ainda não gera direito', () => {
  limpar();
  const id = novoFunc({ dataAdmissao: '2026-01-01' });
  const s = clt.situacaoFerias(db, id, { hoje: '2026-06-01' });
  assert(s.saldoTotal === 0, 'saldo: ' + s.saldoTotal);
  assert(s.periodos[0].completo === false, JSON.stringify(s.periodos[0]));
});

t('período completo gera 30 dias', () => {
  limpar();
  const id = novoFunc({ dataAdmissao: '2024-01-01' });
  const s = clt.situacaoFerias(db, id, { hoje: '2025-06-01' });
  assert(s.saldoTotal === 30, 'saldo: ' + s.saldoTotal);
});

t('dias gozados abatem do saldo', () => {
  limpar();
  const id = novoFunc({ dataAdmissao: '2024-01-01' });
  db.prepare(`INSERT INTO funcionarios_ferias
    (funcionarioId, periodoAquisitivoIni, periodoAquisitivoFim, dataInicio, dataFim, dias, status)
    VALUES (?, '2024-01-01', '2024-12-31', '2025-03-03', '2025-03-22', 20, 'concluida')`).run(id);
  const s = clt.situacaoFerias(db, id, { hoje: '2025-06-01' });
  assert(s.saldoTotal === 10, 'saldo: ' + s.saldoTotal);
});

t('abono pecuniário também abate', () => {
  limpar();
  const id = novoFunc({ dataAdmissao: '2024-01-01' });
  db.prepare(`INSERT INTO funcionarios_ferias
    (funcionarioId, periodoAquisitivoIni, periodoAquisitivoFim, dataInicio, dataFim, dias, diasAbono, status)
    VALUES (?, '2024-01-01', '2024-12-31', '2025-03-03', '2025-03-22', 20, 10, 'concluida')`).run(id);
  assert(clt.situacaoFerias(db, id, { hoje: '2025-06-01' }).saldoTotal === 0, 'deveria zerar');
});

t('férias canceladas não contam como gozadas', () => {
  limpar();
  const id = novoFunc({ dataAdmissao: '2024-01-01' });
  db.prepare(`INSERT INTO funcionarios_ferias
    (funcionarioId, periodoAquisitivoIni, periodoAquisitivoFim, dias, status)
    VALUES (?, '2024-01-01', '2024-12-31', 30, 'cancelada')`).run(id);
  assert(clt.situacaoFerias(db, id, { hoje: '2025-06-01' }).saldoTotal === 30, 'cancelada abateu');
});

t('dentro do concessivo NÃO está vencido — só depois dele (art. 137)', () => {
  limpar();
  const id = novoFunc({ dataAdmissao: '2024-01-01' });
  // Aquisitivo fecha 2024-12-31; concessivo vai até 2025-12-30.
  const dentro = clt.situacaoFerias(db, id, { hoje: '2025-11-01' });
  assert(dentro.diasEmDobro === 0, 'acusou dobro dentro do prazo: ' + dentro.diasEmDobro);
  const fora = clt.situacaoFerias(db, id, { hoje: '2026-01-15' });
  assert(fora.diasEmDobro === 30, 'não acusou dobro: ' + fora.diasEmDobro);
});

t('o passivo em dobro é estimado em dinheiro', () => {
  limpar();
  const id = novoFunc({ dataAdmissao: '2024-01-01', salario: 3000 });
  const s = clt.situacaoFerias(db, id, { hoje: '2026-01-15' });
  assert(perto(s.custoDobroEstimado, 3000), 'custo: ' + s.custoDobroEstimado);
});

t('a vencer nos próximos 90 dias é sinalizado antes de virar dobro', () => {
  limpar();
  const id = novoFunc({ dataAdmissao: '2024-01-01' });
  const s = clt.situacaoFerias(db, id, { hoje: '2025-11-01' });
  assert(s.aVencer.length === 1, JSON.stringify(s.aVencer));
  assert(s.aVencer[0].diasParaVencer === 60, 'dias: ' + s.aVencer[0].diasParaVencer);
});

t('demitido para de acumular período depois da saída', () => {
  limpar();
  const id = novoFunc({ dataAdmissao: '2020-01-01', dataDemissao: '2022-06-30', ativo: 0 });
  const s = clt.situacaoFerias(db, id, { hoje: '2026-01-01' });
  const completos = s.periodos.filter((p) => p.completo).length;
  assert(completos === 2, 'períodos completos: ' + completos);
});

// ==================== FÉRIAS: VALIDAÇÃO ====================
console.log('\n--- férias: o que não pode ser marcado ---');

function comFunc(o = {}) { limpar(); return novoFunc({ dataAdmissao: '2024-01-01', ...o }); }

t('período aquisitivo inventado é recusado', () => {
  const id = comFunc();
  const p = clt.validarFerias(db, id, { periodoAquisitivoIni: '2023-05-15', dias: 30 }, { hoje: '2025-06-01' });
  assert(tem(p, 'aquisitivo_inexistente'), codigos(p));
});

t('marcar férias de período ainda não completo é recusado', () => {
  const id = comFunc();
  const p = clt.validarFerias(db, id, { periodoAquisitivoIni: '2025-01-01', dias: 30 }, { hoje: '2025-06-01' });
  assert(tem(p, 'aquisitivo_incompleto'), codigos(p));
});

t('mais de 30 dias no mesmo período é recusado', () => {
  const id = comFunc();
  const p = clt.validarFerias(db, id, { periodoAquisitivoIni: '2024-01-01', dias: 45 }, { hoje: '2025-06-01' });
  assert(tem(p, 'excede_direito'), codigos(p));
});

t('somar com férias já marcadas também estoura o limite', () => {
  const id = comFunc();
  db.prepare(`INSERT INTO funcionarios_ferias
    (funcionarioId, periodoAquisitivoIni, periodoAquisitivoFim, dataInicio, dataFim, dias, status)
    VALUES (?, '2024-01-01', '2024-12-31', '2025-03-03', '2025-03-22', 20, 'aprovada')`).run(id);
  const p = clt.validarFerias(db, id, { periodoAquisitivoIni: '2024-01-01', dias: 15 }, { hoje: '2025-06-01' });
  assert(tem(p, 'excede_direito'), codigos(p));
});

t('abono acima de 1/3 é recusado (art. 143)', () => {
  const id = comFunc();
  const p = clt.validarFerias(db, id, { periodoAquisitivoIni: '2024-01-01', dias: 15, diasAbono: 11 }, { hoje: '2025-06-01' });
  assert(tem(p, 'abono_acima_do_terco'), codigos(p));
});

t('abono de exatamente 10 dias passa', () => {
  const id = comFunc();
  const p = clt.validarFerias(db, id, { periodoAquisitivoIni: '2024-01-01', dias: 20, diasAbono: 10 }, { hoje: '2025-06-01' });
  assert(naoTem(p, 'abono_acima_do_terco'), codigos(p));
  assert(naoTem(p, 'excede_direito'), codigos(p));
});

t('fracionar em mais de 3 períodos é recusado (art. 134 §1º)', () => {
  const id = comFunc();
  const ins = db.prepare(`INSERT INTO funcionarios_ferias
    (funcionarioId, periodoAquisitivoIni, periodoAquisitivoFim, dias, status)
    VALUES (?, '2024-01-01', '2024-12-31', ?, 'aprovada')`);
  ins.run(id, 14); ins.run(id, 8); ins.run(id, 5);
  const p = clt.validarFerias(db, id, { periodoAquisitivoIni: '2024-01-01', dias: 3 }, { hoje: '2025-06-01' });
  assert(tem(p, 'fracionamento_excedido'), codigos(p));
});

t('período fracionado menor que 5 dias é recusado', () => {
  const id = comFunc();
  db.prepare(`INSERT INTO funcionarios_ferias
    (funcionarioId, periodoAquisitivoIni, periodoAquisitivoFim, dias, status)
    VALUES (?, '2024-01-01', '2024-12-31', 20, 'aprovada')`).run(id);
  const p = clt.validarFerias(db, id, { periodoAquisitivoIni: '2024-01-01', dias: 3 }, { hoje: '2025-06-01' });
  assert(tem(p, 'periodo_menor_que_5'), codigos(p));
});

t('fracionamento sem nenhum período de 14 dias é recusado', () => {
  const id = comFunc();
  db.prepare(`INSERT INTO funcionarios_ferias
    (funcionarioId, periodoAquisitivoIni, periodoAquisitivoFim, dias, status)
    VALUES (?, '2024-01-01', '2024-12-31', 10, 'aprovada')`).run(id);
  const p = clt.validarFerias(db, id, { periodoAquisitivoIni: '2024-01-01', dias: 10 }, { hoje: '2025-06-01' });
  assert(tem(p, 'sem_periodo_de_14'), codigos(p));
});

t('30 dias de uma vez não cai na regra de fracionamento', () => {
  const id = comFunc();
  const p = clt.validarFerias(db, id, { periodoAquisitivoIni: '2024-01-01', dias: 30 }, { hoje: '2025-06-01' });
  assert(naoTem(p, 'sem_periodo_de_14') && naoTem(p, 'periodo_menor_que_5'), codigos(p));
});

t('férias sobrepostas são recusadas', () => {
  const id = comFunc();
  db.prepare(`INSERT INTO funcionarios_ferias
    (funcionarioId, periodoAquisitivoIni, periodoAquisitivoFim, dataInicio, dataFim, dias, status)
    VALUES (?, '2024-01-01', '2024-12-31', '2025-03-03', '2025-03-17', 15, 'aprovada')`).run(id);
  const p = clt.validarFerias(db, id,
    { periodoAquisitivoIni: '2024-01-01', dataInicio: '2025-03-10', dataFim: '2025-03-24', dias: 15 },
    { hoje: '2025-06-01' });
  assert(tem(p, 'ferias_sobrepostas'), codigos(p));
});

t('férias antes da admissão são recusadas', () => {
  const id = comFunc();
  const p = clt.validarFerias(db, id,
    { periodoAquisitivoIni: '2024-01-01', dataInicio: '2023-01-10', dataFim: '2023-02-08', dias: 30 },
    { hoje: '2025-06-01' });
  assert(tem(p, 'ferias_antes_da_admissao'), codigos(p));
});

t('início na sexta é avisado (art. 134 §3º)', () => {
  const id = comFunc();
  // 2025-03-07 é sexta-feira.
  const p = clt.validarFerias(db, id,
    { periodoAquisitivoIni: '2024-01-01', dataInicio: '2025-03-07', dataFim: '2025-03-21', dias: 15 },
    { hoje: '2025-06-01' });
  assert(tem(p, 'inicio_proximo_de_descanso'), codigos(p));
});

t('início na segunda passa', () => {
  const id = comFunc();
  // 2025-03-03 é segunda-feira.
  const p = clt.validarFerias(db, id,
    { periodoAquisitivoIni: '2024-01-01', dataInicio: '2025-03-03', dataFim: '2025-03-17', dias: 15 },
    { hoje: '2025-06-01' });
  assert(naoTem(p, 'inicio_proximo_de_descanso'), codigos(p));
});

t('início dois dias antes de feriado cadastrado é avisado', () => {
  const id = comFunc();
  db.prepare("INSERT INTO feriados (data, descricao, ativo) VALUES ('2025-03-05', 'Feriado local', 1)").run();
  const p = clt.validarFerias(db, id,
    { periodoAquisitivoIni: '2024-01-01', dataInicio: '2025-03-03', dataFim: '2025-03-17', dias: 15 },
    { hoje: '2025-06-01' });
  assert(tem(p, 'inicio_proximo_de_descanso'), codigos(p));
});

t('mais de 32 faltas: sem direito nenhum', () => {
  const id = comFunc();
  const ins = db.prepare("INSERT INTO funcionarios_ponto (funcionarioId, data, tipo) VALUES (?, ?, 'falta')");
  for (let i = 0; i < 40; i++) {
    ins.run(id, new Date(Date.UTC(2024, 2, 1 + i)).toISOString().slice(0, 10));
  }
  const p = clt.validarFerias(db, id, { periodoAquisitivoIni: '2024-01-01', dias: 10 }, { hoje: '2025-06-01' });
  assert(tem(p, 'sem_direito_por_faltas'), codigos(p));
});

t('concessivo vencido avisa que as férias saem em dobro', () => {
  const id = comFunc();
  const p = clt.validarFerias(db, id, { periodoAquisitivoIni: '2024-01-01', dias: 30 }, { hoje: '2026-03-01' });
  const a = p.find((x) => x.codigo === 'concessivo_vencido');
  assert(a && a.nivel === 'aviso', codigos(p));
  assert(/dobro/i.test(a.mensagem), a.mensagem);
});

// ==================== PONTO ====================
console.log('\n--- ponto ---');

t('turno noturno não zera mais as horas', () => {
  // Entrada 22h, saída 6h: a conta antiga dava negativo e virava zero calado.
  const h = clt.calcularHoras({ horaEntrada: '22:00', horaSaida: '06:00' });
  assert(perto(h, 8), 'horas: ' + h);
});

t('intervalo que atravessa a meia-noite também é descontado', () => {
  const h = clt.calcularHoras({ horaEntrada: '20:00', horaSaida: '06:00', horaSaidaAlmoco: '23:30', horaVoltaAlmoco: '00:30' });
  assert(perto(h, 9), 'horas: ' + h);
});

t('jornada diurna normal continua certa', () => {
  const h = clt.calcularHoras({ horaEntrada: '08:00', horaSaida: '18:00', horaSaidaAlmoco: '12:00', horaVoltaAlmoco: '13:00' });
  assert(perto(h, 9), 'horas: ' + h);
});

t('ponto em data futura é recusado', () => {
  const id = comFunc();
  const p = clt.validarPonto(db, id, { data: '2027-01-01', horaEntrada: '08:00', horaSaida: '17:00' }, { hoje: '2026-08-01' });
  assert(tem(p, 'ponto_futuro'), codigos(p));
});

t('ponto antes da admissão é recusado', () => {
  const id = comFunc();
  const p = clt.validarPonto(db, id, { data: '2023-05-01', horaEntrada: '08:00', horaSaida: '17:00' }, { hoje: '2026-08-01' });
  assert(tem(p, 'ponto_antes_da_admissao'), codigos(p));
});

t('ponto depois da demissão é recusado', () => {
  limpar();
  const id = novoFunc({ dataAdmissao: '2024-01-01', dataDemissao: '2025-06-30', ativo: 0 });
  const p = clt.validarPonto(db, id, { data: '2025-08-01', horaEntrada: '08:00', horaSaida: '17:00' }, { hoje: '2026-08-01' });
  assert(tem(p, 'ponto_apos_demissao'), codigos(p));
});

t('bater ponto durante as próprias férias é erro (art. 138)', () => {
  const id = comFunc();
  db.prepare(`INSERT INTO funcionarios_ferias
    (funcionarioId, periodoAquisitivoIni, periodoAquisitivoFim, dataInicio, dataFim, dias, status)
    VALUES (?, '2024-01-01', '2024-12-31', '2025-03-03', '2025-03-17', 15, 'aprovada')`).run(id);
  const p = clt.validarPonto(db, id, { data: '2025-03-10', horaEntrada: '08:00', horaSaida: '17:00' }, { hoje: '2026-08-01' });
  assert(tem(p, 'ponto_durante_ferias'), codigos(p));
});

t('ponto durante atestado é aviso — pode ser o atestado que está errado', () => {
  const id = comFunc();
  db.prepare(`INSERT INTO funcionarios_atestados (funcionarioId, dataInicio, dataFim, dias)
    VALUES (?, '2025-04-01', '2025-04-05', 5)`).run(id);
  const p = clt.validarPonto(db, id, { data: '2025-04-03', horaEntrada: '08:00', horaSaida: '17:00' }, { hoje: '2026-08-01' });
  const a = p.find((x) => x.codigo === 'ponto_durante_atestado');
  assert(a && a.nivel === 'aviso', codigos(p));
});

t('jornada acima de 6h sem 1h de intervalo é avisada (art. 71)', () => {
  const id = comFunc();
  const p = clt.validarPonto(db, id,
    { data: '2025-04-10', horaEntrada: '08:00', horaSaida: '17:00', horaSaidaAlmoco: '12:00', horaVoltaAlmoco: '12:30' },
    { hoje: '2026-08-01' });
  assert(tem(p, 'intervalo_insuficiente'), codigos(p));
});

t('1h cheia de intervalo não gera aviso', () => {
  const id = comFunc();
  const p = clt.validarPonto(db, id,
    { data: '2025-04-11', horaEntrada: '08:00', horaSaida: '17:00', horaSaidaAlmoco: '12:00', horaVoltaAlmoco: '13:00' },
    { hoje: '2026-08-01' });
  assert(naoTem(p, 'intervalo_insuficiente'), codigos(p));
});

t('interjornada menor que 11h é avisada (art. 66)', () => {
  const id = comFunc();
  db.prepare(`INSERT INTO funcionarios_ponto (funcionarioId, data, horaEntrada, horaSaida)
    VALUES (?, '2025-05-05', '14:00', '23:00')`).run(id);
  const p = clt.validarPonto(db, id,
    { data: '2025-05-06', horaEntrada: '07:00', horaSaida: '16:00', horaSaidaAlmoco: '12:00', horaVoltaAlmoco: '13:00' },
    { hoje: '2026-08-01' });
  assert(tem(p, 'interjornada_curta'), codigos(p));
});

t('11h ou mais de descanso não gera aviso', () => {
  const id = comFunc();
  db.prepare(`INSERT INTO funcionarios_ponto (funcionarioId, data, horaEntrada, horaSaida)
    VALUES (?, '2025-05-05', '09:00', '18:00')`).run(id);
  const p = clt.validarPonto(db, id,
    { data: '2025-05-06', horaEntrada: '08:00', horaSaida: '17:00', horaSaidaAlmoco: '12:00', horaVoltaAlmoco: '13:00' },
    { hoje: '2026-08-01' });
  assert(naoTem(p, 'interjornada_curta'), codigos(p));
});

t('mais de 2h extras num dia é avisado (art. 59)', () => {
  const id = comFunc();
  const p = clt.validarPonto(db, id,
    { data: '2025-06-10', horaEntrada: '07:00', horaSaida: '20:00', horaSaidaAlmoco: '12:00', horaVoltaAlmoco: '13:00' },
    { hoje: '2026-08-01' });
  assert(tem(p, 'extras_acima_do_limite'), codigos(p));
});

// ==================== ATESTADOS ====================
console.log('\n--- atestados ---');

t('atestados sobrepostos são recusados', () => {
  const id = comFunc();
  db.prepare(`INSERT INTO funcionarios_atestados (funcionarioId, dataInicio, dataFim, dias)
    VALUES (?, '2025-04-01', '2025-04-10', 10)`).run(id);
  const p = clt.validarAtestado(db, id, { dataInicio: '2025-04-05', dataFim: '2025-04-15' });
  assert(tem(p, 'atestado_sobreposto'), codigos(p));
});

t('afastamento acima de 15 dias manda encaminhar ao INSS', () => {
  const id = comFunc();
  const p = clt.validarAtestado(db, id, { dataInicio: '2025-04-01', dataFim: '2025-04-25' });
  assert(tem(p, 'encaminhar_inss'), codigos(p));
});

t('15 dias exatos ainda são da empresa', () => {
  const id = comFunc();
  const p = clt.validarAtestado(db, id, { dataInicio: '2025-04-01', dataFim: '2025-04-15' });
  assert(naoTem(p, 'encaminhar_inss'), codigos(p));
});

t('atestados do mesmo CID em 60 dias somam para o limite do INSS', () => {
  const id = comFunc();
  db.prepare(`INSERT INTO funcionarios_atestados (funcionarioId, dataInicio, dataFim, dias, cid)
    VALUES (?, '2025-04-01', '2025-04-10', 10, 'M54')`).run(id);
  // Isolado seriam 8 dias; somado ao anterior passa de 15.
  const p = clt.validarAtestado(db, id, { dataInicio: '2025-05-01', dataFim: '2025-05-08', cid: 'M54' });
  assert(tem(p, 'encaminhar_inss'), codigos(p));
});

t('CID diferente não soma', () => {
  const id = comFunc();
  db.prepare(`INSERT INTO funcionarios_atestados (funcionarioId, dataInicio, dataFim, dias, cid)
    VALUES (?, '2025-04-01', '2025-04-10', 10, 'M54')`).run(id);
  const p = clt.validarAtestado(db, id, { dataInicio: '2025-05-01', dataFim: '2025-05-08', cid: 'J11' });
  assert(naoTem(p, 'encaminhar_inss'), codigos(p));
});

t('doença durante as férias avisa que o gozo é interrompido', () => {
  const id = comFunc();
  db.prepare(`INSERT INTO funcionarios_ferias
    (funcionarioId, periodoAquisitivoIni, periodoAquisitivoFim, dataInicio, dataFim, dias, status)
    VALUES (?, '2024-01-01', '2024-12-31', '2025-03-03', '2025-03-17', 15, 'aprovada')`).run(id);
  const p = clt.validarAtestado(db, id, { dataInicio: '2025-03-08', dataFim: '2025-03-12' });
  assert(tem(p, 'atestado_durante_ferias'), codigos(p));
});

t('fim antes do início é recusado', () => {
  const id = comFunc();
  const p = clt.validarAtestado(db, id, { dataInicio: '2025-04-10', dataFim: '2025-04-01' });
  assert(tem(p, 'periodo_invertido'), codigos(p));
});

// ==================== PAINEL ====================
console.log('\n--- painel de alertas ---');

t('lista quem já tem férias vencidas e soma o passivo', () => {
  limpar();
  novoFunc({ nome: 'Ana', dataAdmissao: '2023-01-01', salario: 3000 });
  novoFunc({ nome: 'Bruno', dataAdmissao: '2026-01-01', salario: 3000, cpf: '529.982.247-25' });
  const a = clt.alertasRH(db, { hoje: '2026-06-01' });
  assert(a.feriasVencidas.length === 1 && a.feriasVencidas[0].nome === 'Ana', JSON.stringify(a.feriasVencidas));
  assert(a.passivoFeriasEstimado > 0, 'passivo: ' + a.passivoFeriasEstimado);
});

t('não conta funcionário desligado', () => {
  limpar();
  novoFunc({ nome: 'Antigo', dataAdmissao: '2020-01-01', ativo: 0, dataDemissao: '2021-01-01' });
  assert(clt.alertasRH(db, { hoje: '2026-06-01' }).feriasVencidas.length === 0, 'contou demitido');
});

t('sinaliza contrato de experiência chegando aos 90 dias (art. 445)', () => {
  limpar();
  novoFunc({ nome: 'Novato', dataAdmissao: '2026-04-01' });
  const a = clt.alertasRH(db, { hoje: '2026-06-15' });
  assert(a.experienciaAVencer.length === 1, JSON.stringify(a.experienciaAVencer));
  assert(a.experienciaAVencer[0].limite === '2026-06-29', a.experienciaAVencer[0].limite);
});

t('cadastro sem CPF válido é apontado', () => {
  limpar();
  novoFunc({ nome: 'SemCpf', cpf: null });
  novoFunc({ nome: 'CpfTorto', cpf: '111.111.111-11' });
  novoFunc({ nome: 'Ok', cpf: '529.982.247-25' });
  const a = clt.alertasRH(db, { hoje: '2026-06-01' });
  assert(a.cadastroIncompleto.length === 2, JSON.stringify(a.cadastroIncompleto.map((x) => x.nome)));
});

t('aniversariantes do mês saem ordenados por dia', () => {
  limpar();
  novoFunc({ nome: 'B', dataNascimento: '1990-06-20' });
  novoFunc({ nome: 'A', dataNascimento: '1985-06-03', cpf: '529.982.247-25' });
  novoFunc({ nome: 'C', dataNascimento: '1992-09-01', cpf: '168.995.350-09' });
  const a = clt.alertasRH(db, { hoje: '2026-06-15' });
  assert(a.aniversariantes.map((x) => x.nome).join('') === 'AB', JSON.stringify(a.aniversariantes));
});

t('absenteísmo do mês conta faltas registradas', () => {
  limpar();
  const id = novoFunc({ nome: 'Faltoso', dataAdmissao: '2024-01-01' });
  const ins = db.prepare("INSERT INTO funcionarios_ponto (funcionarioId, data, tipo) VALUES (?, ?, 'falta')");
  ins.run(id, '2026-06-02'); ins.run(id, '2026-06-09');
  ins.run(id, '2026-05-10');   // mês anterior, não conta
  const a = clt.alertasRH(db, { hoje: '2026-06-15' });
  assert(a.absenteismoMes.length === 1 && a.absenteismoMes[0].faltas === 2, JSON.stringify(a.absenteismoMes));
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
