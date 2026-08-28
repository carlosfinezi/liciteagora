/**
 * perfis.js — perfis de indústria do módulo Produção.
 *
 * O núcleo do módulo não sabe o que é concreto, tinta ou papel: sabe ficha,
 * ordem, recurso, etapa, ensaio e apontamento. O que muda de uma fábrica para
 * outra é o VOCABULÁRIO e o CONJUNTO INICIAL de etapas e ensaios — e é isso
 * que um perfil traz.
 *
 * Um perfil é semente, não trilho: depois de aplicado, o tenant edita as
 * etapas como quiser. Trocar o perfil depois não apaga nada — só acrescenta o
 * que falta (ver `aplicarPerfil`).
 *
 * ─── POR QUE O VOCABULÁRIO É DADO, E NÃO TELA DUPLICADA ─────────────────────
 * A alternativa seria uma tela de "Formas" para concreto e outra de "Máquinas"
 * para metalurgia, com o mesmo código. Duas telas iguais divergem na terceira
 * correção. Aqui a tela é uma só e pergunta ao backend como chamar as coisas
 * (`GET /api/producao/vocabulario`), então "Recurso" vira "Forma/Pista" para
 * quem faz pré-moldado sem que exista uma segunda tela para manter.
 *
 * O vocabulário é rótulo, nunca chave: `prod_etapas.codigo` continua sendo o
 * identificador estável. Renomear "Concretagem" para "Vazamento" na tela não
 * mexe em nenhum dado gravado.
 */

const VOCABULARIO_BASE = {
  modulo: 'Produção',
  ficha: 'Ficha técnica',
  fichas: 'Fichas técnicas',
  item: 'Item',
  itens: 'Itens',
  unidade: 'Unidade produzida',
  unidades: 'Unidades produzidas',
  recurso: 'Recurso',
  recursos: 'Recursos produtivos',
  lote: 'Lote de processo',
  lotes: 'Lotes de processo',
  ensaio: 'Ensaio',
  ensaios: 'Ensaios',
  projeto: 'Projeto',
  projetos: 'Projetos',
  patio: 'Estoque de acabados',
  iniciarProcesso: 'Iniciar processo',
  liberarSaida: 'Liberar saída',
  tempoProcesso: 'Tempo de processo',
  quantidadeBase: 'Quantidade base',
};

const PERFIS = {
  // ─── O padrão: manufatura discreta, sem jargão de segmento ───────────────
  generico: {
    nome: 'Genérico (manufatura discreta)',
    descricao: 'Etapas neutras que servem à maioria das fábricas. Renomeie as '
      + 'etapas para o vocabulário da sua operação.',
    vocabulario: {},
    etapas: [
      { codigo: 'preparacao',  nome: 'Preparação',  ordem: 1, individual: 1, contaProducao: 0 },
      { codigo: 'processo',    nome: 'Processo',    ordem: 2, individual: 0, contaProducao: 0 },
      { codigo: 'acabamento',  nome: 'Acabamento',  ordem: 3, individual: 1, contaProducao: 0 },
      // A etapa que marca a unidade PRONTA. Só ela soma produção.
      { codigo: 'inspecao',    nome: 'Inspeção',    ordem: 4, individual: 1, contaProducao: 1 },
      { codigo: 'expedicao',   nome: 'Expedição',   ordem: 5, individual: 0, contaProducao: 0 },
    ],
    ensaioTipos: [],
  },

  // ─── Pré-moldados: o perfil que originou o módulo ─────────────────────────
  premoldados: {
    nome: 'Pré-moldados de concreto',
    descricao: 'Fábrica de peças de concreto: armação, forma, concretagem, cura '
      + 'e desforma, com corpo de prova travando a liberação da protensão.',
    vocabulario: {
      modulo: 'Pré-moldados',
      item: 'Peça',
      itens: 'Peças',
      unidade: 'Peça produzida',
      unidades: 'Peças produzidas',
      recurso: 'Forma / Pista',
      recursos: 'Formas e pistas',
      lote: 'Betonada',
      lotes: 'Betonadas',
      ensaio: 'Corpo de prova',
      ensaios: 'Corpos de prova',
      projeto: 'Obra',
      projetos: 'Obras',
      patio: 'Pátio',
      iniciarProcesso: 'Registrar concretagem',
      liberarSaida: 'Liberar desforma',
      tempoProcesso: 'Tempo de cura',
      quantidadeBase: 'Volume de concreto',
    },
    etapas: [
      { codigo: 'armacao',     nome: 'Armação',     ordem: 1, individual: 1, contaProducao: 0 },
      { codigo: 'forma',       nome: 'Forma',       ordem: 2, individual: 0, contaProducao: 0 },
      { codigo: 'concretagem', nome: 'Concretagem', ordem: 3, individual: 0, contaProducao: 0 },
      // A peça só está pronta quando sai da forma.
      { codigo: 'desforma',    nome: 'Desforma',    ordem: 4, individual: 0, contaProducao: 1 },
      { codigo: 'acabamento',  nome: 'Acabamento',  ordem: 5, individual: 1, contaProducao: 0 },
      { codigo: 'carga',       nome: 'Carga',       ordem: 6, individual: 0, contaProducao: 0 },
    ],
    ensaioTipos: [
      { codigo: 'fck_transferencia', nome: 'Resistência de transferência',
        unidade: 'MPa', idadePadraoDias: 1, finalidade: 'liberacao' },
      { codigo: 'fck_controle', nome: 'Resistência de controle (7 dias)',
        unidade: 'MPa', idadePadraoDias: 7, finalidade: 'conformidade' },
      { codigo: 'fck_projeto', nome: 'Resistência de projeto (28 dias)',
        unidade: 'MPa', idadePadraoDias: 28, finalidade: 'conformidade' },
    ],
  },
};

const PERFIL_PADRAO = 'generico';

function perfilAtual(db) {
  try {
    const r = db.prepare("SELECT valor FROM config WHERE chave = 'producao_perfil'").get();
    const p = r && r.valor;
    return PERFIS[p] ? p : PERFIL_PADRAO;
  } catch (_) {
    return PERFIL_PADRAO;
  }
}

/** Rótulos do perfil ativo, com o base preenchendo o que ele não sobrescreve. */
function vocabulario(db) {
  const chave = perfilAtual(db);
  return { ...VOCABULARIO_BASE, ...(PERFIS[chave].vocabulario || {}), perfil: chave };
}

/**
 * Aplica o perfil: grava a escolha e semeia etapas e tipos de ensaio.
 *
 * ACRESCENTA, nunca apaga. Duas razões: trocar de perfil não pode destruir
 * etapa que já tem apontamento gravado, e o tenant que renomeou "Concretagem"
 * para "Vazamento" não pode ver o nome voltar sozinho numa reaplicação.
 *
 * O casamento é por `codigo`. Etapa que já existe é deixada como está.
 */
function aplicarPerfil(db, chave, { usuario } = {}) {
  const perfil = PERFIS[chave];
  if (!perfil) {
    return { erro: `perfil desconhecido: ${chave} (use ${Object.keys(PERFIS).join(', ')})` };
  }

  const insEtapa = db.prepare(`
    INSERT INTO prod_etapas (codigo, nome, ordem, individual, contaProducao, ativo)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(codigo) DO NOTHING
  `);
  const insEnsaio = db.prepare(`
    INSERT INTO prod_ensaio_tipos (codigo, nome, unidade, idadePadraoDias, finalidade, ativo)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(codigo) DO NOTHING
  `);

  const codigos = perfil.etapas.map(e => e.codigo);
  const marcadores = codigos.map(() => '?').join(',');
  const avisos = [];

  const tx = db.transaction(() => {
    for (const e of perfil.etapas) {
      insEtapa.run(e.codigo, e.nome, e.ordem, e.individual, e.contaProducao);
      // Etapa do perfil que existia desativada volta a valer.
      db.prepare('UPDATE prod_etapas SET ativo = 1 WHERE codigo = ?').run(e.codigo);
    }
    for (const t of perfil.ensaioTipos) {
      insEnsaio.run(t.codigo, t.nome, t.unidade, t.idadePadraoDias, t.finalidade);
    }

    // ─── As etapas do perfil ANTERIOR não podem ficar no caminho ───────────
    // Trocar de perfil sem isto acumulava as duas listas: o tenant ficava com
    // "inspeção" (do genérico) E "desforma" (de pré-moldados) marcadas como
    // contaProducao, e a mesma unidade era contada duas vezes.
    //
    // Quem já tem apontamento gravado NÃO é desativada — apagar a etapa
    // tornaria o histórico ilegível. Perde só o `contaProducao`, que é o que
    // causaria a contagem dupla; continua visível e apontável.
    const forasteiras = db.prepare(
      `SELECT id, codigo, contaProducao FROM prod_etapas WHERE codigo NOT IN (${marcadores})`
    ).all(...codigos);

    for (const f of forasteiras) {
      const usada = db.prepare(
        'SELECT 1 FROM prod_apontamentos WHERE etapa = ? LIMIT 1'
      ).get(f.codigo) != null;

      if (usada) {
        if (f.contaProducao) {
          db.prepare('UPDATE prod_etapas SET contaProducao = 0 WHERE id = ?').run(f.id);
          avisos.push(`a etapa "${f.codigo}" tem apontamento gravado: foi mantida, mas deixou `
            + 'de contar produção para não duplicar a contagem com a etapa do novo perfil');
        }
      } else {
        db.prepare('UPDATE prod_etapas SET ativo = 0 WHERE id = ?').run(f.id);
      }
    }

    db.prepare(`
      INSERT INTO config (chave, valor) VALUES ('producao_perfil', ?)
      ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
    `).run(chave);
  });
  tx();

  return {
    perfil: chave,
    vocabulario: vocabulario(db),
    etapas: listarEtapas(db),
    ensaioTipos: db.prepare('SELECT * FROM prod_ensaio_tipos ORDER BY id').all(),
    avisos,
  };
}

/**
 * Garante que existe ao menos uma etapa cadastrada.
 *
 * Sem etapa nenhuma o apontamento não funciona — e um módulo recém-ligado que
 * abre com a tela morta é indistinguível de um módulo quebrado. Na primeira
 * vez, semeia o perfil escolhido (ou o genérico).
 */
function garantirSeed(db) {
  let temEtapa = false;
  try {
    temEtapa = db.prepare('SELECT 1 FROM prod_etapas LIMIT 1').get() != null;
  } catch (_) {
    return null; // tabela ainda não criada: o schema roda antes
  }
  if (temEtapa) return null;
  return aplicarPerfil(db, perfilAtual(db));
}

function listarEtapas(db, { apenasAtivas = false } = {}) {
  const sql = apenasAtivas
    ? 'SELECT * FROM prod_etapas WHERE ativo = 1 ORDER BY ordem, id'
    : 'SELECT * FROM prod_etapas ORDER BY ordem, id';
  try { return db.prepare(sql).all(); } catch (_) { return []; }
}

module.exports = {
  PERFIS, PERFIL_PADRAO, VOCABULARIO_BASE,
  perfilAtual, vocabulario, aplicarPerfil, garantirSeed, listarEtapas,
};
