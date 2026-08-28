/**
 * apontamento.js — apontamento de chão de fábrica (F1.6).
 *
 * ─── POR QUE O APONTAMENTO É POR EQUIPE ─────────────────────────────────────
 * Uma concretagem envolve armador, montador de forma, operador de betoneira e
 * vibrador ao mesmo tempo. "Esta viga foi do João" é ficção, e um ranking
 * individual construído sobre ela faria o dono premiar e demitir com base em
 * número inventado.
 *
 * Por isso `equipeId` é o normal e `funcionarioId` é a exceção — reservado às
 * etapas que são individuais de fato (armação por kg, acabamento). As duas
 * colunas existem; o que muda é qual delas a etapa preenche.
 *
 * ─── HORAS ≠ HOMEM-HORA ─────────────────────────────────────────────────────
 * `horas` aqui é hora-RELÓGIO do apontamento (fim − início). O homem-hora — o
 * denominador de todo indicador — é calculado em produtividade.js e prefere o
 * PONTO (`funcionarios_ponto`) ao que foi digitado. Ver o cabeçalho de lá.
 */

const { num, normalizarData, normalizarInstante, horasEntre, agora } = require('./prod-util');

// ─── AS ETAPAS SÃO CADASTRO, NÃO CONSTANTE ───────────────────────────────────
// Eram um enum fixo com as etapas do concreto. Uma gráfica não tem armação nem
// desforma; uma fundição não tem forma no mesmo sentido. Agora vêm de
// `prod_etapas`, semeadas pelo perfil de indústria (ver perfis.js) e editáveis
// pelo tenant.
//
// Duas propriedades da etapa decidem comportamento, e por isso são lidas do
// banco a cada validação em vez de memorizadas:
//   individual    — se atribuir o trabalho a UMA pessoa faz sentido
//   contaProducao — se é a etapa em que a unidade fica pronta

function etapasAtivas(db) {
  try {
    return db.prepare('SELECT * FROM prod_etapas WHERE ativo = 1 ORDER BY ordem, id').all();
  } catch (_) {
    return [];
  }
}

function acharEtapa(db, codigo) {
  try {
    return db.prepare('SELECT * FROM prod_etapas WHERE codigo = ? AND ativo = 1').get(codigo) || null;
  } catch (_) {
    return null;
  }
}

/** Códigos das etapas que marcam a unidade pronta. Sem nenhuma, produção não soma. */
function etapasQueContam(db) {
  return etapasAtivas(db).filter(e => e.contaProducao).map(e => e.codigo);
}

function etapasIndividuais(db) {
  return etapasAtivas(db).filter(e => e.individual).map(e => e.codigo);
}

// Status de OP que aceitam apontamento. Antes de liberar não há o que apontar;
// depois de concluída, o número já virou custo e estoque.
const STATUS_APONTAVEL = ['liberada', 'em_processo', 'liberada_saida'];

function validar(db, dados) {
  const etapa = acharEtapa(db, dados.etapa);
  if (!etapa) {
    const ativas = etapasAtivas(db).map(e => e.codigo);
    return ativas.length
      ? `etapa inválida: use ${ativas.join(', ')}`
      : 'não há etapa de produção cadastrada — aplique um perfil de indústria em Configuração';
  }

  const data = normalizarData(dados.data);
  if (!data) return 'data inválida';

  if (!dados.equipeId && !dados.funcionarioId) {
    return 'informe equipeId (o normal) ou funcionarioId (só em etapa individual)';
  }
  if (dados.funcionarioId && !etapa.individual) {
    const ind = etapasIndividuais(db);
    return `a etapa "${etapa.nome}" é coletiva: aponte a equipe, não a pessoa. `
      + (ind.length ? `Individual só em: ${ind.join(', ')}` : 'Nenhuma etapa está marcada como individual.');
  }
  if (dados.equipeId) {
    const e = db.prepare('SELECT id, ativo FROM prod_equipes WHERE id = ?').get(dados.equipeId);
    if (!e) return 'equipeId não existe';
    if (!e.ativo) return 'equipe inativa';
  }
  if (dados.funcionarioId) {
    // `funcionarios` vem do rh-routes e não existe em todo tenant.
    try {
      const f = db.prepare('SELECT id FROM funcionarios WHERE id = ?').get(dados.funcionarioId);
      if (!f) return 'funcionarioId não existe';
    } catch (e) {
      if (/no such table/i.test(e.message)) {
        return 'apontamento individual exige o módulo de RH (cadastro de funcionários) instalado';
      }
      throw e;
    }
  }

  // Campo ausente é ZERO, não erro: o apontamento de armação não informa
  // refugo, e exigir "0" explícito só ensina o operador a digitar ruído.
  // Valor PRESENTE e inválido (negativo, texto) continua sendo erro.
  const produzida = quantidadeOpcional(dados.quantidadeProduzida);
  if (produzida == null) return 'quantidadeProduzida deve ser um número >= 0';
  const refugo = quantidadeOpcional(dados.quantidadeRefugo);
  if (refugo == null) return 'quantidadeRefugo deve ser um número >= 0';

  // A regra que faz o indicador de refugo valer alguma coisa.
  if (refugo > 0 && !String(dados.motivoRefugo || '').trim()) {
    return 'refugo exige motivoRefugo: refugo sem motivo não muda comportamento nenhum';
  }

  if (dados.horaInicio && dados.horaFim) {
    const h = horasEntre(`${data} ${normalizarHora(dados.horaInicio)}`,
      `${data} ${normalizarHora(dados.horaFim)}`);
    if (h == null) return 'horaInicio/horaFim inválidas';
    if (h <= 0) return 'horaFim deve ser depois de horaInicio';
    if (h > 24) return 'apontamento acima de 24h: confira as horas';
  } else if (num(dados.horas, { min: 0, max: 24 }) == null) {
    return 'informe horaInicio+horaFim, ou horas entre 0 e 24';
  }

  if (dados.pessoas != null && dados.pessoas !== '' && num(dados.pessoas, { min: 1, max: 200 }) == null) {
    return 'pessoas deve estar entre 1 e 200';
  }
  return null;
}

/** Ausente vira 0; presente e inválido vira null (que o chamador trata como erro). */
function quantidadeOpcional(valor) {
  if (valor == null || valor === '') return 0;
  return num(valor, { min: 0 });
}

function normalizarHora(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(:(\d{2}))?$/);
  if (!m) return null;
  const p = n => String(n).padStart(2, '0');
  return `${p(Number(m[1]))}:${m[2]}:${m[4] || '00'}`;
}

/**
 * Cria o apontamento. Não mexe no status da OP nem no estoque: quem transiciona
 * é op.js. Aqui só se registra o que foi feito.
 */
function criar(db, opId, dados, usuario) {
  const op = db.prepare('SELECT id, numero, status FROM prod_ordens WHERE id = ?').get(opId);
  if (!op) return { erro: 'OP não encontrada' };
  if (!STATUS_APONTAVEL.includes(op.status)) {
    return { erro: `OP em status "${op.status}" não aceita apontamento `
      + `(aceita: ${STATUS_APONTAVEL.join(', ')})` };
  }

  const erro = validar(db, dados);
  if (erro) return { erro };

  const data = normalizarData(dados.data);
  const hIni = dados.horaInicio ? normalizarHora(dados.horaInicio) : null;
  const hFim = dados.horaFim ? normalizarHora(dados.horaFim) : null;
  const horas = (hIni && hFim)
    ? horasEntre(`${data} ${hIni}`, `${data} ${hFim}`)
    : Number(dados.horas);

  // `pessoas` congela o tamanho da equipe NESTE dia: a composição muda com o
  // tempo, e recalcular pelo cadastro atual reescreveria o passado.
  const pessoas = dados.funcionarioId
    ? 1
    : (num(dados.pessoas, { min: 1 }) ?? tamanhoEquipeAtual(db, dados.equipeId) ?? null);

  const r = db.prepare(`
    INSERT INTO prod_apontamentos
      (opId, equipeId, funcionarioId, etapa, data, horaInicio, horaFim, horas, pessoas,
       quantidadeProduzida, quantidadeRefugo, motivoRefugo, observacoes, usuario)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(opId, dados.equipeId || null, dados.funcionarioId || null, dados.etapa, data,
    hIni, hFim, horas, pessoas, Number(dados.quantidadeProduzida || 0),
    Number(dados.quantidadeRefugo || 0), dados.motivoRefugo || null,
    dados.observacoes || null, usuario || null);

  return { apontamento: db.prepare('SELECT * FROM prod_apontamentos WHERE id = ?').get(r.lastInsertRowid) };
}

function tamanhoEquipeAtual(db, equipeId) {
  if (!equipeId) return null;
  const n = db.prepare(
    'SELECT COUNT(*) n FROM prod_equipe_membros WHERE equipeId = ? AND ativo = 1'
  ).get(equipeId).n;
  return n || null;
}

function remover(db, id) {
  const a = db.prepare('SELECT a.*, o.status FROM prod_apontamentos a JOIN prod_ordens o ON o.id = a.opId WHERE a.id = ?').get(id);
  if (!a) return { erro: 'apontamento não encontrado' };
  if (a.status === 'concluida') {
    return { erro: 'OP concluída: o apontamento já virou custo da peça e não pode ser removido' };
  }
  db.prepare('DELETE FROM prod_apontamentos WHERE id = ?').run(id);
  return { removido: true };
}

/**
 * Totais apontados numa OP. É o default de `concluir` — o operador não deve
 * ter de somar à mão o que já apontou.
 *
 * Só a etapa `desforma` conta produção: apontar 10 na armação e 10 na
 * concretagem não são 20 peças, são as mesmas 10 passando por duas etapas.
 * O refugo, ao contrário, soma de TODAS as etapas — uma peça pode ser perdida
 * na armação e outra na desforma.
 */
function totaisApontados(db, opId) {
  // Só as etapas marcadas com contaProducao somam produção — ver o bloco no
  // topo. Sem nenhuma marcada, o total é zero e a conclusão pede a quantidade.
  const contam = etapasQueContam(db);
  const prod = contam.length
    ? db.prepare(`
        SELECT COALESCE(SUM(quantidadeProduzida), 0) AS q
          FROM prod_apontamentos
         WHERE opId = ? AND etapa IN (${contam.map(() => '?').join(',')})
      `).get(opId, ...contam).q
    : 0;
  const ref = db.prepare(`
    SELECT COALESCE(SUM(quantidadeRefugo), 0) AS q FROM prod_apontamentos WHERE opId = ?
  `).get(opId).q;
  const horas = db.prepare(`
    SELECT COALESCE(SUM(horas), 0) AS h FROM prod_apontamentos WHERE opId = ?
  `).get(opId).h;
  return { quantidadeProduzida: prod, quantidadeRefugo: ref, horas };
}

// ─── Equipes ─────────────────────────────────────────────────────────────────

// A especialidade de uma equipe é a etapa em que ela trabalha, mais 'mista'
// para quem faz de tudo. Deriva do cadastro de etapas pelo mesmo motivo que
// elas deixaram de ser constante: 'concretagem' não existe numa gráfica.
function especialidades(db) {
  return [...etapasAtivas(db).map(e => e.codigo), 'mista'];
}

function salvarEquipe(db, id, dados) {
  const nome = String(dados.nome || '').trim();
  if (!nome) return { erro: 'nome é obrigatório' };
  const esp = dados.especialidade || 'mista';
  const validas = especialidades(db);
  if (!validas.includes(esp)) {
    return { erro: `especialidade inválida: use ${validas.join(', ')}` };
  }
  const dup = db.prepare('SELECT id FROM prod_equipes WHERE nome = ? AND (? IS NULL OR id <> ?)')
    .get(nome, id, id);
  if (dup) return { erro: `já existe equipe chamada "${nome}"` };

  if (id) {
    db.prepare(`
      UPDATE prod_equipes SET nome = ?, especialidade = ?, encarregadoFuncionarioId = ?, ativo = ?
       WHERE id = ?
    `).run(nome, esp, dados.encarregadoFuncionarioId || null,
      dados.ativo === 0 || dados.ativo === '0' ? 0 : 1, id);
    return { equipe: db.prepare('SELECT * FROM prod_equipes WHERE id = ?').get(id) };
  }
  const r = db.prepare(`
    INSERT INTO prod_equipes (nome, especialidade, encarregadoFuncionarioId, ativo)
    VALUES (?, ?, ?, ?)
  `).run(nome, esp, dados.encarregadoFuncionarioId || null,
    dados.ativo === 0 || dados.ativo === '0' ? 0 : 1);
  return { equipe: db.prepare('SELECT * FROM prod_equipes WHERE id = ?').get(r.lastInsertRowid) };
}

function definirMembros(db, equipeId, funcionarioIds) {
  const e = db.prepare('SELECT id FROM prod_equipes WHERE id = ?').get(equipeId);
  if (!e) return { erro: 'equipe não encontrada' };
  if (!Array.isArray(funcionarioIds)) return { erro: 'funcionarioIds deve ser uma lista' };

  try {
    for (const fid of funcionarioIds) {
      const f = db.prepare('SELECT id FROM funcionarios WHERE id = ?').get(fid);
      if (!f) return { erro: `funcionário #${fid} não existe` };
    }
  } catch (e) {
    if (/no such table/i.test(e.message)) {
      return { erro: 'montar equipe exige o módulo de RH (cadastro de funcionários) instalado' };
    }
    throw e;
  }

  const tx = db.transaction(() => {
    // Desativa em vez de apagar: o apontamento antigo tem de continuar
    // explicável, e um DELETE reescreveria a composição do passado.
    db.prepare('UPDATE prod_equipe_membros SET ativo = 0, dataSaida = ? WHERE equipeId = ? AND ativo = 1')
      .run(agora(), equipeId);
    const up = db.prepare(`
      INSERT INTO prod_equipe_membros (equipeId, funcionarioId, ativo, dataSaida)
      VALUES (?, ?, 1, NULL)
      ON CONFLICT(equipeId, funcionarioId) DO UPDATE SET ativo = 1, dataSaida = NULL
    `);
    for (const fid of funcionarioIds) up.run(equipeId, fid);
  });
  tx();

  return { membros: listarMembros(db, equipeId) };
}

function listarMembros(db, equipeId) {
  try {
    return db.prepare(`
      SELECT m.*, f.nome AS funcionarioNome, f.cargo
        FROM prod_equipe_membros m
        JOIN funcionarios f ON f.id = m.funcionarioId
       WHERE m.equipeId = ? AND m.ativo = 1
       ORDER BY f.nome
    `).all(equipeId);
  } catch (e) {
    // Tenant sem RH: devolve os vínculos sem o nome, em vez de 500.
    if (!/no such table/i.test(e.message)) throw e;
    return db.prepare(
      'SELECT * FROM prod_equipe_membros WHERE equipeId = ? AND ativo = 1'
    ).all(equipeId);
  }
}

module.exports = {
  STATUS_APONTAVEL, especialidades,
  etapasAtivas, acharEtapa, etapasQueContam, etapasIndividuais,
  validar, criar, remover, totaisApontados, normalizarHora,
  salvarEquipe, definirMembros, listarMembros, tamanhoEquipeAtual,
};
