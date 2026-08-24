/**
 * governanca-alcadas.js — a decisão de quem precisa aprovar o quê.
 *
 * Quatro defeitos motivaram este módulo, todos reproduzidos antes de corrigir:
 *
 *  1. FAIXAS NÃO EXISTIAM. A regra aplicada era sempre a de MENOR limite
 *     (`ORDER BY limiteValor ASC LIMIT 1`). Com "até 1k livre, 1k–50k
 *     financeiro, acima de 50k admin", um pagamento de R$ 500.000 caía na
 *     alçada do financeiro. A tabela existe justamente para ter degraus.
 *
 *  2. A APROVAÇÃO NÃO TRAVAVA O VALOR. Aprovava-se R$ 5.000 e, alterando o
 *     título depois, a mesma aprovação liberava R$ 500.000 — o consumo só
 *     olhava `status` e `consumida`. É a falha mais cara das quatro.
 *
 *  3. REPROVAR MATAVA O DOCUMENTO. Uma vez reprovada, toda execução seguinte
 *     reencontrava aquela reprovação e devolvia "reprovado" para sempre. Não
 *     havia como corrigir o valor e reenviar.
 *
 *  4. APROVAÇÃO NÃO EXPIRAVA. Uma aprovação de 2024 liberava um pagamento
 *     hoje.
 *
 * A regra que vale é a de MAIOR limite que o valor ultrapassa — e é o papel
 * DELA que decide quem pode aprovar, gravado na própria aprovação para o
 * aprovador não depender de uma consulta que pode mudar depois.
 */

const TIPOS_EVENTO = ['pagamento_cp', 'pedido_compra'];
const VALIDADE_PADRAO_DIAS = 7;

const erro = (codigo, mensagem, extra = {}) => ({ nivel: 'erro', codigo, mensagem, ...extra });
const aviso = (codigo, mensagem, extra = {}) => ({ nivel: 'aviso', codigo, mensagem, ...extra });

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* idempotente */ } }

function migrarDB(db) {
  // Sem validade, uma aprovação vale para sempre.
  alterSafe(db, `ALTER TABLE regras_alcada ADD COLUMN validadeDias INTEGER DEFAULT ${VALIDADE_PADRAO_DIAS}`);
  alterSafe(db, 'ALTER TABLE regras_alcada ADD COLUMN descricao TEXT');
  // O aprovador precisa saber qual regra o convocou; buscar "uma regra do tipo"
  // na hora de decidir podia trazer o papel de outra faixa.
  alterSafe(db, 'ALTER TABLE aprovacoes ADD COLUMN regraId INTEGER');
  alterSafe(db, 'ALTER TABLE aprovacoes ADD COLUMN papelExigido TEXT');
  alterSafe(db, 'ALTER TABLE aprovacoes ADD COLUMN valorAprovado REAL');
  alterSafe(db, 'ALTER TABLE aprovacoes ADD COLUMN expiraEm TEXT');
  // Auto-aprovação (2026-08-21): quando o admin libera a própria solicitação,
  // a linha fica marcada. Sem isso, no histórico ela é indistinguível de uma
  // aprovação feita por outra pessoa.
  alterSafe(db, 'ALTER TABLE aprovacoes ADD COLUMN autoAprovada INTEGER DEFAULT 0');
  alterSafe(db, 'CREATE INDEX IF NOT EXISTS idx_aprov_status ON aprovacoes(status, dataCriacao)');
}

// Chave de config do tenant que libera o admin a aprovar a própria
// solicitação. Desligada por omissão: a alçada existe justamente para separar
// quem pede de quem libera, então afrouxar isso é escolha explícita do tenant.
const CHAVE_AUTO_APROVA = 'alcada_admin_autoaprova';

function autoAprovaAdminLigada(db) {
  try {
    const row = db.prepare('SELECT valor FROM config WHERE chave = ?').get(CHAVE_AUTO_APROVA);
    return !!(row && row.valor === '1');
  } catch { return false; }
}

/**
 * O solicitante pode decidir a própria solicitação? Só quando ele é admin e o
 * tenant ligou a chave — e mesmo assim apenas para aprovar; reprovar o próprio
 * pedido sempre foi permitido.
 */
function podeAutoAprovar(db, aprovacao, usuario) {
  if (!usuario || !aprovacao) return false;
  if (usuario.username !== aprovacao.solicitante) return false;
  return usuario.role === 'admin' && autoAprovaAdminLigada(db);
}

const agoraISO = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
const somaDias = (base, dias) =>
  new Date(new Date(String(base).replace(' ', 'T') + 'Z').getTime() + dias * 86400000)
    .toISOString().slice(0, 19).replace('T', ' ');

// ==================== REGRA APLICÁVEL ====================

/**
 * A faixa em que o valor cai: a regra de MAIOR limite que ele ultrapassa.
 *
 * Com regras de 1.000 e 50.000:
 *   R$    500 → nenhuma (não ultrapassa nada) → segue sem aprovação
 *   R$  5.000 → a de 1.000
 *   R$ 500.000 → a de 50.000
 *
 * Antes era sempre a de menor limite, e a faixa alta nunca era alcançada.
 */
function regraAplicavel(db, tipoEvento, valor) {
  const v = Number(valor) || 0;
  return db.prepare(`SELECT * FROM regras_alcada
    WHERE tipoEvento = ? AND ativo = 1 AND limiteValor < ?
    ORDER BY limiteValor DESC LIMIT 1`).get(tipoEvento, v) || null;
}

/** Todas as faixas de um evento, da menor para a maior. */
function faixas(db, tipoEvento) {
  return db.prepare(`SELECT * FROM regras_alcada
    WHERE tipoEvento = ? AND ativo = 1 ORDER BY limiteValor ASC`).all(tipoEvento);
}

// ==================== VERIFICAÇÃO ====================

/**
 * Hook dos fluxos de pagamento e compra.
 *
 * @returns {object}
 *   { liberado: true }                          — sem faixa aplicável, ou aprovação válida consumida
 *   { liberado: false, status, aprovacaoId, … } — pendente, reprovada ou expirada
 */
function verificarAlcada(db, { tipoEvento, referenciaId, valor, usuario = null, agora = null }) {
  const v = Number(valor) || 0;
  const regra = regraAplicavel(db, tipoEvento, v);
  if (!regra) return { liberado: true };

  const hoje = agora || agoraISO();

  const existente = db.prepare(`SELECT * FROM aprovacoes
    WHERE tipoEvento = ? AND referenciaId = ? AND consumida = 0
    ORDER BY id DESC LIMIT 1`).get(tipoEvento, referenciaId);

  if (existente && existente.status === 'aprovada') {
    // ---- a aprovação vale para ESTE valor? ----
    // Pagar menos que o aprovado é seguro; mais, não. Sem esta checagem, uma
    // aprovação de R$ 5.000 liberava R$ 500.000 depois de alterarem o título.
    const teto = existente.valorAprovado != null ? Number(existente.valorAprovado)
      : (existente.valorReferencia != null ? Number(existente.valorReferencia) : null);
    if (teto != null && v > teto + 0.005) {
      return {
        liberado: false, status: 'valor_excedido', aprovacaoId: existente.id, regra,
        valorAprovado: teto, valorSolicitado: v,
        motivo: `Aprovado até ${teto.toFixed(2)}; a execução é de ${v.toFixed(2)}. `
              + 'Solicite nova aprovação para o valor maior.',
      };
    }

    // ---- ainda está no prazo? ----
    if (existente.expiraEm && hoje > existente.expiraEm) {
      return {
        liberado: false, status: 'expirada', aprovacaoId: existente.id, regra,
        expirouEm: existente.expiraEm,
        motivo: `Aprovação venceu em ${existente.expiraEm}. Solicite de novo.`,
      };
    }

    db.prepare('UPDATE aprovacoes SET consumida = 1 WHERE id = ?').run(existente.id);
    return { liberado: true, aprovacaoId: existente.id, regra };
  }

  if (existente && existente.status === 'pendente') {
    // Valor mudou enquanto esperava decisão: quem for aprovar precisa ver o
    // número que vai ser executado, não o que foi pedido.
    if (existente.valorReferencia != null && Math.abs(Number(existente.valorReferencia) - v) > 0.005) {
      db.prepare('UPDATE aprovacoes SET valorReferencia = ? WHERE id = ?').run(v, existente.id);
    }
    return { liberado: false, status: 'pendente', aprovacaoId: existente.id, regra };
  }

  if (existente && existente.status === 'reprovada') {
    // Reprovar tem que valer alguma coisa: com o MESMO valor, continua barrado
    // (senão bastava reenviar em loop). Com valor diferente, é outro pedido e
    // merece nova solicitação — antes o documento ficava morto para sempre.
    const mesmoValor = existente.valorReferencia != null
      && Math.abs(Number(existente.valorReferencia) - v) <= 0.005;
    if (mesmoValor) {
      return {
        liberado: false, status: 'reprovada', aprovacaoId: existente.id, regra,
        motivo: existente.motivo || null,
      };
    }
    db.prepare('UPDATE aprovacoes SET consumida = 1 WHERE id = ?').run(existente.id);
  }

  const validade = Number(regra.validadeDias) > 0 ? Number(regra.validadeDias) : VALIDADE_PADRAO_DIAS;
  const r = db.prepare(`INSERT INTO aprovacoes
    (tipoEvento, referenciaId, valorReferencia, solicitante, regraId, papelExigido, dataCriacao, expiraEm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    tipoEvento, referenciaId, v, usuario, regra.id, regra.papelAprovador, hoje, somaDias(hoje, validade));

  // `criada` distingue "acabei de abrir a solicitação" de "já existia e
  // continua pendente". Sem isso o aviso ao aprovador sairia de novo a cada
  // tentativa de pagar, e um alerta repetido vira alerta ignorado.
  return { liberado: false, status: 'pendente', aprovacaoId: r.lastInsertRowid, regra, criada: true };
}

// ==================== DECISÃO ====================

/**
 * Quem pode decidir esta aprovação.
 * O papel vem da PRÓPRIA aprovação (gravado quando ela nasceu), não de uma
 * consulta nova — a regra pode ter sido editada no meio do caminho, e quem
 * aprova precisa responder pela faixa que realmente bloqueou.
 */
function podeDecidir(db, aprovacao, usuario) {
  if (!usuario) return { pode: false, motivo: 'Não autenticado' };
  const papel = aprovacao.papelExigido
    || (db.prepare('SELECT papelAprovador FROM regras_alcada WHERE id = ?').get(aprovacao.regraId || -1) || {}).papelAprovador
    || 'admin';

  if (usuario.role !== 'admin' && usuario.role !== papel) {
    return { pode: false, papel, motivo: `Apenas o papel "${papel}" (ou admin) pode decidir` };
  }
  return { pode: true, papel };
}

// ==================== VALIDAÇÃO DE REGRA ====================

function validarRegra(db, dados, opts = {}) {
  const p = [];
  const roles = opts.roles || ['admin'];

  if (!TIPOS_EVENTO.includes(dados.tipoEvento)) {
    p.push(erro('tipo_invalido', `tipoEvento deve ser: ${TIPOS_EVENTO.join(' ou ')}`));
  }
  const limite = Number(dados.limiteValor);
  if (!Number.isFinite(limite) || limite < 0) {
    p.push(erro('limite_invalido', 'Limite deve ser um valor não negativo'));
  }
  if (dados.papelAprovador && !roles.includes(dados.papelAprovador)) {
    // Papel inexistente é trava eterna: nada nunca vai ser aprovado.
    p.push(erro('papel_invalido', `Papel "${dados.papelAprovador}" não existe. Use: ${roles.join(', ')}`));
  }
  const validade = dados.validadeDias;
  if (validade != null && validade !== '' && !(Number(validade) > 0 && Number(validade) <= 365)) {
    p.push(erro('validade_invalida', 'Validade da aprovação deve ficar entre 1 e 365 dias'));
  }

  if (Number.isFinite(limite) && TIPOS_EVENTO.includes(dados.tipoEvento)) {
    try {
      const igual = db.prepare(`SELECT id FROM regras_alcada
        WHERE tipoEvento = ? AND ativo = 1 AND ABS(limiteValor - ?) < 0.005 AND id <> ?`)
        .get(dados.tipoEvento, limite, opts.id || -1);
      if (igual) {
        // Duas faixas no mesmo ponto: qual delas vale é imprevisível.
        p.push(erro('faixa_duplicada',
          `Já existe uma faixa de ${limite.toFixed(2)} para este evento (#${igual.id})`));
      }
    } catch { /* tabela ainda não migrada */ }
  }

  // Papel sem nenhuma pessoa que possa exercê-lo trava o fluxo inteiro.
  if (dados.papelAprovador) {
    try {
      const n = db.prepare(`SELECT COUNT(*) n FROM users
        WHERE ativo = 1 AND (role = ? OR role = 'admin')`).get(dados.papelAprovador).n;
      if (!n) {
        p.push(erro('sem_aprovador',
          `Nenhum usuário ativo com o papel "${dados.papelAprovador}" nem admin — `
          + 'nada acima deste limite conseguiria ser aprovado'));
      }
    } catch { /* tenant sem users */ }
  }

  return p;
}

// ==================== DIAGNÓSTICO ====================

const DIA = 86400000;

/**
 * O que está travando. Alçada mal configurada não dá erro: ela para o
 * pagamento e ninguém sabe por quê.
 */
function diagnostico(db, opts = {}) {
  const hoje = opts.agora || agoraISO();
  const diasParado = opts.diasParado || 3;

  const regras = db.prepare('SELECT * FROM regras_alcada WHERE ativo = 1 ORDER BY tipoEvento, limiteValor').all();

  const problemas = [];
  for (const tipo of TIPOS_EVENTO) {
    const doTipo = regras.filter((r) => r.tipoEvento === tipo);
    if (!doTipo.length) continue;

    for (const r of doTipo) {
      try {
        const n = db.prepare(`SELECT COUNT(*) n FROM users
          WHERE ativo = 1 AND (role = ? OR role = 'admin')`).get(r.papelAprovador).n;
        if (!n) {
          problemas.push(aviso('faixa_sem_aprovador',
            `${tipo}: a faixa acima de ${Number(r.limiteValor).toFixed(2)} exige o papel `
            + `"${r.papelAprovador}", e não há nenhum usuário ativo com ele`, { regraId: r.id }));
        }
      } catch { /* sem users */ }
    }

    // Uma pessoa só no papel exigido: se for ela quem solicitou, ninguém decide
    // (o solicitante não aprova a própria solicitação). Com a auto-aprovação de
    // admin ligada esse beco não existe, e o aviso vira ruído — some.
    if (!autoAprovaAdminLigada(db)) {
      for (const r of doTipo) {
        try {
          const aptos = db.prepare(`SELECT COUNT(*) n FROM users
            WHERE ativo = 1 AND (role = ? OR role = 'admin')`).get(r.papelAprovador).n;
          if (aptos === 1) {
            problemas.push(aviso('aprovador_unico',
              `${tipo}: só uma pessoa pode aprovar a faixa acima de ${Number(r.limiteValor).toFixed(2)}. `
              + 'Se for ela quem solicitar, a aprovação trava', { regraId: r.id }));
          }
        } catch { /* sem users */ }
      }
    }
  }

  const pendentes = db.prepare(`SELECT * FROM aprovacoes WHERE status = 'pendente' ORDER BY dataCriacao`).all();
  const paradas = pendentes
    .map((a) => ({
      ...a,
      dias: Math.floor((new Date(String(hoje).replace(' ', 'T') + 'Z')
        - new Date(String(a.dataCriacao).replace(' ', 'T') + 'Z')) / DIA),
    }))
    .filter((a) => a.dias >= diasParado);

  const expiradas = db.prepare(`SELECT * FROM aprovacoes
    WHERE status = 'aprovada' AND consumida = 0 AND expiraEm IS NOT NULL AND expiraEm < ?`).all(hoje);

  const reprovadasAbertas = db.prepare(`SELECT * FROM aprovacoes
    WHERE status = 'reprovada' AND consumida = 0`).all();

  return {
    referencia: hoje,
    faixasPorEvento: TIPOS_EVENTO.map((tipo) => ({
      tipoEvento: tipo,
      faixas: faixas(db, tipo).map((r) => ({
        id: r.id, acimaDe: r.limiteValor, papel: r.papelAprovador,
        validadeDias: r.validadeDias || VALIDADE_PADRAO_DIAS,
      })),
    })),
    problemas,
    pendentes: pendentes.length,
    // Aprovação parada é pagamento parado — normalmente ninguém foi avisado.
    paradas: paradas.map((a) => ({
      id: a.id, tipoEvento: a.tipoEvento, referenciaId: a.referenciaId,
      valor: a.valorReferencia, solicitante: a.solicitante, dias: a.dias, papelExigido: a.papelExigido,
    })),
    expiradas: expiradas.map((a) => ({
      id: a.id, tipoEvento: a.tipoEvento, referenciaId: a.referenciaId,
      valor: a.valorReferencia, expirouEm: a.expiraEm,
    })),
    reprovadasAbertas: reprovadasAbertas.map((a) => ({
      id: a.id, tipoEvento: a.tipoEvento, referenciaId: a.referenciaId,
      valor: a.valorReferencia, motivo: a.motivo,
    })),
  };
}

/**
 * Simulação: um valor deste evento passaria, e por quem?
 * A tela mostrava limites soltos; saber o efeito exige testar mentalmente as
 * faixas, e é aí que o erro de configuração passa despercebido.
 */
function simular(db, tipoEvento, valor) {
  const v = Number(valor) || 0;
  const regra = regraAplicavel(db, tipoEvento, v);
  if (!regra) {
    return { valor: v, exigeAprovacao: false,
      explicacao: 'Abaixo de todas as faixas configuradas — segue sem aprovação.' };
  }
  let aptos = null;
  try {
    aptos = db.prepare(`SELECT username FROM users WHERE ativo = 1 AND (role = ? OR role = 'admin')`)
      .all(regra.papelAprovador).map((u) => u.username);
  } catch { /* sem users */ }
  return {
    valor: v, exigeAprovacao: true,
    regraId: regra.id, acimaDe: regra.limiteValor, papel: regra.papelAprovador,
    validadeDias: regra.validadeDias || VALIDADE_PADRAO_DIAS,
    podemAprovar: aptos,
    explicacao: `Cai na faixa acima de ${Number(regra.limiteValor).toFixed(2)}: exige aprovação de `
      + `"${regra.papelAprovador}"`
      + (aptos ? (aptos.length ? ` (${aptos.join(', ')})` : ' — e não há ninguém com esse papel') : ''),
  };
}

module.exports = {
  TIPOS_EVENTO, VALIDADE_PADRAO_DIAS,
  migrarDB,
  regraAplicavel, faixas,
  verificarAlcada, podeDecidir,
  validarRegra, diagnostico, simular,
  CHAVE_AUTO_APROVA, autoAprovaAdminLigada, podeAutoAprovar,
};
