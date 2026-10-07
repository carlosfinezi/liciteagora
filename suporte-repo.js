'use strict';
/**
 * suporte-repo.js — o único caminho até os chamados.
 *
 * Os chamados de todas as empresas vivem na MESMA tabela do control.db. O
 * isolamento, portanto, não é físico: é esta camada. Ela existe para que
 * nenhuma rota precise lembrar de escrever `WHERE tenant_id = ?`.
 *
 * ── A regra que organiza o arquivo ──────────────────────────────────────────
 *
 * Tudo que uma rota de TENANT pode chamar termina em `DoTenant` e recebe o
 * `tenantId` como PRIMEIRO argumento, depois do `db`. Não existe, de
 * propósito, um `buscarChamado(id)` exportado: a única forma de chegar a um
 * chamado pelo lado do cliente passa por uma função que não monta a consulta
 * sem o tenant.
 *
 * O lado da equipe vive no objeto `admin`, separado e nomeado. Quem ler
 * `suporteRepo.admin.buscarChamado(db, id)` numa rota de tenant vê o erro na
 * própria linha.
 *
 * ── Por que 404 e não 403 ───────────────────────────────────────────────────
 *
 * Chamado de outra empresa é tratado como INEXISTENTE: as funções `DoTenant`
 * devolvem `null`, e a rota traduz para 404. Um 403 confirmaria que aquele id
 * existe, o que é exatamente a informação que a enumeração procura. Esta é a
 * razão de `buscarChamadoDoTenant` não ter uma variante "existe, mas é de
 * outro": do ponto de vista do cliente, não existe.
 *
 * ── O que esta camada NÃO faz ───────────────────────────────────────────────
 *
 * Não escapa HTML e não decide apresentação. O corpo da mensagem é guardado
 * como o usuário escreveu, e quem renderiza é que trata como texto. Misturar
 * as duas coisas produz dado escapado duas vezes no banco.
 */

const { STATUS, PRIORIDADES } = require('./suporte-schema');

/** Status em que o cliente ainda pode responder sem reabrir. */
const STATUS_ABERTOS = ['aberto', 'em_atendimento', 'aguardando_cliente'];

/**
 * O portão. Toda função do lado do cliente começa por aqui.
 *
 * Recusar em vez de devolver vazio é deliberado: `tenantId` ausente costuma
 * ser um bug de quem chamou (sessão não resolvida, parâmetro trocado), e
 * devolver lista vazia esconderia isso até alguém reclamar que "sumiram os
 * chamados". Pior ainda seria tratar `undefined` como "todos".
 */
function exigirTenant(tenantId) {
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('suporte-repo: tenantId obrigatório e inválido — consulta recusada');
  }
  return id;
}

function exigirInteiroPositivo(valor, nome) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`suporte-repo: ${nome} inválido`);
  return n;
}

function texto(v, nome, { max = 4000, obrigatorio = true } = {}) {
  const s = String(v == null ? '' : v).trim();
  if (!s && obrigatorio) throw new Error(`suporte-repo: ${nome} é obrigatório`);
  if (s.length > max) throw new Error(`suporte-repo: ${nome} passa de ${max} caracteres`);
  return s || null;
}

/** Número visível do chamado: ANO-SEQUENCIAL, único no control.db. */
function proximoNumero(db) {
  const ano = new Date().getFullYear();
  const row = db.prepare(
    `SELECT numero FROM suporte_chamados WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`
  ).get(`${ano}-%`);
  const seq = row ? Number(String(row.numero).split('-')[1]) + 1 : 1;
  return `${ano}-${String(seq).padStart(4, '0')}`;
}

function registrarHistorico(db, chamadoId, { action, actorTipo, actorId = null, actorNome = null, payload = null }) {
  db.prepare(`
    INSERT INTO suporte_historico (chamado_id, action, actor_tipo, actor_id, actor_nome, payload, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(chamadoId, action, actorTipo, actorId, actorNome,
    payload == null ? null : JSON.stringify(payload), Date.now());
}

// ══════════════════════════════════════════════════════════════════════════
//  LADO DO CLIENTE — tudo exige tenantId
// ══════════════════════════════════════════════════════════════════════════

/**
 * Abre um chamado para UMA empresa.
 * @returns {{id:number, numero:string}}
 */
function criarChamadoDoTenant(db, tenantId, dados = {}) {
  const tid = exigirTenant(tenantId);

  const empresa = db.prepare('SELECT id FROM tenants WHERE id = ?').get(tid);
  if (!empresa) throw new Error('suporte-repo: tenant inexistente');

  const assunto = texto(dados.assunto, 'assunto', { max: 160 });
  const descricao = texto(dados.descricao, 'descrição', { max: 8000 });

  /* A categoria manda na prioridade e no prazo quando quem abre não escolhe.
     É por isso que nada disso está no código: o valor vem da tabela. */
  let categoria = null;
  if (dados.categoriaId != null) {
    categoria = db.prepare('SELECT * FROM suporte_categorias WHERE id = ? AND ativo = 1')
      .get(Number(dados.categoriaId));
    if (!categoria) throw new Error('suporte-repo: categoria inexistente ou inativa');
  }

  /* A prioridade NÃO vem de quem abre o chamado.
   *
   * Ela sai da categoria, e só a equipe a ajusta depois. A razão é simples: se
   * o cliente escolhesse, tudo seria urgente em duas semanas, e a fila
   * deixaria de ordenar coisa alguma.
   *
   * O descarte acontece AQUI, e não na rota, pelo mesmo motivo do `tenantId`:
   * uma rota que esqueça de filtrar o corpo da requisição não pode virar
   * escalada de prioridade. `dados.prioridade` é ignorado de propósito —
   * mandar `{prioridade: 'urgente'}` não tem efeito nenhum. */
  const prioridade = categoria?.prioridade_padrao || 'normal';
  if (!PRIORIDADES.includes(prioridade)) throw new Error(`suporte-repo: prioridade inválida "${prioridade}"`);

  const agora = Date.now();
  const slaHoras = categoria?.sla_horas ?? null;

  const tx = db.transaction(() => {
    const numero = proximoNumero(db);
    const r = db.prepare(`
      INSERT INTO suporte_chamados
        (tenant_id, numero, categoria_id, assunto, descricao, prioridade, status,
         aberto_por_user_id, aberto_por_nome, aberto_por_email,
         created_at, updated_at, sla_vence_at)
      VALUES (?, ?, ?, ?, ?, ?, 'aberto', ?, ?, ?, ?, ?, ?)
    `).run(tid, numero, categoria ? categoria.id : null, assunto, descricao, prioridade,
      dados.abertoPorUserId ?? null,
      texto(dados.abertoPorNome, 'nome', { max: 120, obrigatorio: false }),
      texto(dados.abertoPorEmail, 'e-mail', { max: 160, obrigatorio: false }),
      agora, agora,
      slaHoras == null ? null : agora + slaHoras * 3600 * 1000);

    const id = Number(r.lastInsertRowid);
    registrarHistorico(db, id, {
      action: 'aberto', actorTipo: 'cliente',
      actorId: dados.abertoPorUserId ?? null, actorNome: dados.abertoPorNome ?? null,
      payload: { categoria: categoria?.slug ?? null, prioridade },
    });
    return { id, numero };
  });
  return tx();
}

/**
 * O chamado daquela empresa, ou `null`.
 *
 * `null` cobre dois casos de propósito: não existe, e existe mas é de outro
 * tenant. A rota devolve 404 nos dois, e nada vaza sobre o id alheio.
 */
function buscarChamadoDoTenant(db, tenantId, chamadoId) {
  const tid = exigirTenant(tenantId);
  const cid = Number(chamadoId);
  if (!Number.isInteger(cid) || cid <= 0) return null;
  return db.prepare(`
    SELECT c.*, cat.slug AS categoria_slug, cat.nome AS categoria_nome
      FROM suporte_chamados c
      LEFT JOIN suporte_categorias cat ON cat.id = c.categoria_id
     WHERE c.id = ? AND c.tenant_id = ?
  `).get(cid, tid) || null;
}

/** Os chamados daquela empresa. Nunca de duas. */
function listarChamadosDoTenant(db, tenantId, filtros = {}) {
  const tid = exigirTenant(tenantId);
  let sql = `
    SELECT c.*, cat.slug AS categoria_slug, cat.nome AS categoria_nome
      FROM suporte_chamados c
      LEFT JOIN suporte_categorias cat ON cat.id = c.categoria_id
     WHERE c.tenant_id = ?`;
  const args = [tid];
  if (filtros.status) {
    if (!STATUS.includes(filtros.status)) throw new Error(`suporte-repo: status inválido "${filtros.status}"`);
    sql += ' AND c.status = ?'; args.push(filtros.status);
  }
  if (filtros.abertos) { sql += ` AND c.status IN (${STATUS_ABERTOS.map(() => '?').join(',')})`; args.push(...STATUS_ABERTOS); }
  if (filtros.abertoPorUserId != null) { sql += ' AND c.aberto_por_user_id = ?'; args.push(Number(filtros.abertoPorUserId)); }
  sql += ' ORDER BY c.updated_at DESC, c.id DESC';
  if (filtros.limite) { sql += ' LIMIT ?'; args.push(exigirInteiroPositivo(filtros.limite, 'limite')); }
  return db.prepare(sql).all(...args);
}

/**
 * As mensagens que o cliente pode ver: as públicas, nunca as internas.
 *
 * O filtro `interna = 0` está no SQL, e não numa limpeza depois, porque é o
 * único lugar em que ele não pode ser esquecido por quem montar a tela.
 */
function listarMensagensDoTenant(db, tenantId, chamadoId) {
  const chamado = buscarChamadoDoTenant(db, tenantId, chamadoId);
  if (!chamado) return null;
  return db.prepare(`
    SELECT id, chamado_id, autor_tipo, autor_id, autor_nome, corpo, created_at
      FROM suporte_mensagens
     WHERE chamado_id = ? AND interna = 0
     ORDER BY created_at, id
  `).all(chamado.id);
}

/**
 * Responde um chamado da própria empresa.
 *
 * Não existe parâmetro `interna` aqui: pelo lado do cliente a mensagem é
 * sempre pública. Se um dia alguém passar `{ interna: 1 }` por engano, não há
 * onde isso entrar — e o CHECK do banco recusaria de todo modo, porque o
 * autor é 'cliente'.
 */
function responderChamadoDoTenant(db, tenantId, chamadoId, dados = {}) {
  const chamado = buscarChamadoDoTenant(db, tenantId, chamadoId);
  if (!chamado) return null;
  if (chamado.status === 'encerrado') throw new Error('suporte-repo: chamado encerrado — reabra antes de responder');

  const corpo = texto(dados.corpo, 'mensagem', { max: 8000 });
  const agora = Date.now();

  const tx = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO suporte_mensagens (chamado_id, autor_tipo, autor_id, autor_nome, corpo, interna, created_at)
      VALUES (?, 'cliente', ?, ?, ?, 0, ?)
    `).run(chamado.id, dados.autorId ?? null,
      texto(dados.autorNome, 'nome', { max: 120, obrigatorio: false }), corpo, agora);

    /* Resposta do cliente devolve a bola para a equipe: um chamado que estava
       'aguardando_cliente' volta a correr. */
    const novoStatus = chamado.status === 'aguardando_cliente' ? 'em_atendimento' : chamado.status;
    db.prepare('UPDATE suporte_chamados SET updated_at = ?, status = ? WHERE id = ?')
      .run(agora, novoStatus, chamado.id);

    registrarHistorico(db, chamado.id, {
      action: 'mensagem_cliente', actorTipo: 'cliente',
      actorId: dados.autorId ?? null, actorNome: dados.autorNome ?? null,
      payload: novoStatus !== chamado.status ? { status: [chamado.status, novoStatus] } : null,
    });
    return Number(r.lastInsertRowid);
  });
  return tx();
}

/**
 * Prazo para reabrir um chamado já resolvido.
 *
 * Vira configuração na fase das categorias administráveis; por ora é uma
 * constante com nome, e não um `30` solto no meio de um `if`.
 */
const DIAS_PARA_REABRIR = 7;

/**
 * Diz se o chamado pode ser reaberto, e por quê não quando não pode.
 *
 * Só `resolvido` reabre, e dentro do prazo. `encerrado` não reabre de
 * propósito: encerrado é ponto final, e o caminho é abrir um chamado novo —
 * senão uma conversa de três meses atrás volta à vida sem contexto.
 */
function podeReabrir(chamado) {
  if (!chamado) return { pode: false, motivo: 'inexistente' };
  if (chamado.status !== 'resolvido') {
    return { pode: false, motivo: chamado.status === 'encerrado' ? 'encerrado' : 'ainda_aberto' };
  }
  const limite = (chamado.resolvido_at || 0) + DIAS_PARA_REABRIR * 86400 * 1000;
  if (Date.now() > limite) return { pode: false, motivo: 'prazo_vencido' };
  return { pode: true };
}

/**
 * Reabre um chamado resolvido da própria empresa, com a justificativa virando
 * a primeira mensagem — reabrir sem dizer o que continua errado só devolve o
 * chamado para a fila sem informação nova.
 */
function reabrirChamadoDoTenant(db, tenantId, chamadoId, dados = {}) {
  const chamado = buscarChamadoDoTenant(db, tenantId, chamadoId);
  if (!chamado) return null;

  const veredito = podeReabrir(chamado);
  if (!veredito.pode) {
    const porque = {
      encerrado: 'Este chamado foi encerrado. Abra um chamado novo.',
      ainda_aberto: 'Este chamado ainda está em andamento.',
      prazo_vencido: `O prazo de ${DIAS_PARA_REABRIR} dias para reabrir já passou. Abra um chamado novo.`,
    }[veredito.motivo] || 'Este chamado não pode ser reaberto.';
    throw new Error(porque);
  }

  const corpo = texto(dados.corpo, 'motivo da reabertura', { max: 8000 });
  const agora = Date.now();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO suporte_mensagens (chamado_id, autor_tipo, autor_id, autor_nome, corpo, interna, created_at)
      VALUES (?, 'cliente', ?, ?, ?, 0, ?)
    `).run(chamado.id, dados.autorId ?? null,
      texto(dados.autorNome, 'nome', { max: 120, obrigatorio: false }), corpo, agora);

    db.prepare(`
      UPDATE suporte_chamados
         SET status = 'em_atendimento', updated_at = ?, resolvido_at = NULL,
             reaberturas = reaberturas + 1
       WHERE id = ?
    `).run(agora, chamado.id);

    registrarHistorico(db, chamado.id, {
      action: 'reaberto', actorTipo: 'cliente',
      actorId: dados.autorId ?? null, actorNome: dados.autorNome ?? null,
      payload: { de: chamado.status, reaberturas: chamado.reaberturas + 1 },
    });
  });
  tx();
  return { status: 'em_atendimento', reaberturas: chamado.reaberturas + 1 };
}

/** As categorias que a tela de abertura oferece. Não depende de tenant. */
function listarCategoriasAtivas(db) {
  return db.prepare('SELECT * FROM suporte_categorias WHERE ativo = 1 ORDER BY ordem, nome').all();
}

// ══════════════════════════════════════════════════════════════════════════
//  LADO DA EQUIPE — atravessa tenants DE PROPÓSITO, e por isso fica aqui,
//  num objeto com nome. Só o host `admin` com superAdminId chega a estas
//  funções; a separação em `admin.` é o que faz um uso errado saltar à vista
//  na revisão de uma rota de tenant.
// ══════════════════════════════════════════════════════════════════════════

const admin = {
  /** Um chamado qualquer, com a empresa dona junto. */
  buscarChamado(db, chamadoId) {
    const cid = Number(chamadoId);
    if (!Number.isInteger(cid) || cid <= 0) return null;
    return db.prepare(`
      SELECT c.*, t.slug AS tenant_slug, t.name AS tenant_nome,
             cat.slug AS categoria_slug, cat.nome AS categoria_nome
        FROM suporte_chamados c
        JOIN tenants t ON t.id = c.tenant_id
        LEFT JOIN suporte_categorias cat ON cat.id = c.categoria_id
       WHERE c.id = ?
    `).get(cid) || null;
  },

  /** A fila da equipe, de todas as empresas. */
  listarChamados(db, filtros = {}) {
    let sql = `
      SELECT c.*, t.slug AS tenant_slug, t.name AS tenant_nome,
             cat.slug AS categoria_slug, cat.nome AS categoria_nome
        FROM suporte_chamados c
        JOIN tenants t ON t.id = c.tenant_id
        LEFT JOIN suporte_categorias cat ON cat.id = c.categoria_id
       WHERE 1=1`;
    const args = [];
    if (filtros.tenantId) { sql += ' AND c.tenant_id = ?'; args.push(exigirInteiroPositivo(filtros.tenantId, 'tenantId')); }
    if (filtros.status) {
      if (!STATUS.includes(filtros.status)) throw new Error(`suporte-repo: status inválido "${filtros.status}"`);
      sql += ' AND c.status = ?'; args.push(filtros.status);
    }
    if (filtros.abertos) { sql += ` AND c.status IN (${STATUS_ABERTOS.map(() => '?').join(',')})`; args.push(...STATUS_ABERTOS); }
    if (filtros.responsavelAdminId != null) { sql += ' AND c.responsavel_admin_id = ?'; args.push(Number(filtros.responsavelAdminId)); }
    if (filtros.semResponsavel) sql += ' AND c.responsavel_admin_id IS NULL';
    /* "Sem resposta" é a ausência de mensagem da EQUIPE, e não um campo: um
       `primeira_resposta_at` escrito por fora mente quando alguém responde por
       outro caminho. O fato observável é a mensagem existir. */
    if (filtros.semResposta) {
      sql += ` AND NOT EXISTS (SELECT 1 FROM suporte_mensagens m
                                WHERE m.chamado_id = c.id AND m.autor_tipo = 'equipe' AND m.interna = 0)`;
    }
    if (filtros.atrasados) { sql += ' AND c.sla_vence_at IS NOT NULL AND c.sla_vence_at < ? AND c.status NOT IN (?, ?)'; args.push(Date.now(), 'resolvido', 'encerrado'); }
    sql += ' ORDER BY c.updated_at DESC, c.id DESC';
    if (filtros.limite) { sql += ' LIMIT ?'; args.push(exigirInteiroPositivo(filtros.limite, 'limite')); }
    return db.prepare(sql).all(...args);
  },

  /** Todas as mensagens, inclusive as internas. */
  listarMensagens(db, chamadoId) {
    const cid = exigirInteiroPositivo(chamadoId, 'chamadoId');
    return db.prepare(`
      SELECT * FROM suporte_mensagens WHERE chamado_id = ? ORDER BY created_at, id
    `).all(cid);
  },

  /** Resposta da equipe. `interna: true` é a nota que o cliente não vê. */
  responder(db, chamadoId, dados = {}) {
    const chamado = admin.buscarChamado(db, chamadoId);
    if (!chamado) return null;
    const corpo = texto(dados.corpo, 'mensagem', { max: 8000 });
    const interna = dados.interna ? 1 : 0;
    const agora = Date.now();

    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO suporte_mensagens (chamado_id, autor_tipo, autor_id, autor_nome, corpo, interna, created_at)
        VALUES (?, 'equipe', ?, ?, ?, ?, ?)
      `).run(chamado.id, dados.adminId ?? null,
        texto(dados.adminNome, 'nome', { max: 120, obrigatorio: false }), corpo, interna, agora);

      /* Nota interna não mexe no estado: ela é conversa da equipe consigo
         mesma, e marcar 'aguardando_cliente' aqui faria o cliente esperar
         uma resposta que ele nunca viu. */
      if (!interna) {
        const campos = ['updated_at = ?', 'status = ?'];
        const args = [agora, chamado.status === 'encerrado' ? chamado.status : 'aguardando_cliente'];
        if (!chamado.primeira_resposta_at) { campos.push('primeira_resposta_at = ?'); args.push(agora); }
        args.push(chamado.id);
        db.prepare(`UPDATE suporte_chamados SET ${campos.join(', ')} WHERE id = ?`).run(...args);
      } else {
        db.prepare('UPDATE suporte_chamados SET updated_at = ? WHERE id = ?').run(agora, chamado.id);
      }

      registrarHistorico(db, chamado.id, {
        action: interna ? 'nota_interna' : 'mensagem_equipe', actorTipo: 'equipe',
        actorId: dados.adminId ?? null, actorNome: dados.adminNome ?? null,
      });
      return Number(r.lastInsertRowid);
    });
    return tx();
  },

  /** Muda o status, registrando quem mudou e de onde para onde. */
  mudarStatus(db, chamadoId, novoStatus, ator = {}) {
    const chamado = admin.buscarChamado(db, chamadoId);
    if (!chamado) return null;
    if (!STATUS.includes(novoStatus)) throw new Error(`suporte-repo: status inválido "${novoStatus}"`);
    if (chamado.status === novoStatus) return chamado.status;

    const agora = Date.now();
    const tx = db.transaction(() => {
      const campos = ['status = ?', 'updated_at = ?'];
      const args = [novoStatus, agora];
      if (novoStatus === 'resolvido') { campos.push('resolvido_at = ?'); args.push(agora); }
      if (novoStatus === 'encerrado') { campos.push('encerrado_at = ?'); args.push(agora); }
      args.push(chamado.id);
      db.prepare(`UPDATE suporte_chamados SET ${campos.join(', ')} WHERE id = ?`).run(...args);
      registrarHistorico(db, chamado.id, {
        action: 'status', actorTipo: ator.tipo || 'equipe',
        actorId: ator.id ?? null, actorNome: ator.nome ?? null,
        payload: { de: chamado.status, para: novoStatus },
      });
    });
    tx();
    return novoStatus;
  },

  /**
   * Atribui o chamado a alguém da equipe.
   *
   * A coluna existe desde a Fase 1 por decisão sua, mesmo sem papéis
   * separados: hoje todo super-admin pode tudo, e `responsavel_admin_id` só
   * diz quem está com a bola. Quando houver papéis, nada aqui muda de forma.
   */
  atribuir(db, chamadoId, responsavelAdminId, ator = {}) {
    const chamado = admin.buscarChamado(db, chamadoId);
    if (!chamado) return null;
    const alvo = responsavelAdminId == null ? null : exigirInteiroPositivo(responsavelAdminId, 'responsavelAdminId');
    if (alvo != null) {
      const existe = db.prepare('SELECT id FROM super_admins WHERE id = ?').get(alvo);
      if (!existe) throw new Error('suporte-repo: responsável inexistente');
    }
    const tx = db.transaction(() => {
      db.prepare('UPDATE suporte_chamados SET responsavel_admin_id = ?, updated_at = ? WHERE id = ?')
        .run(alvo, Date.now(), chamado.id);
      registrarHistorico(db, chamado.id, {
        action: alvo == null ? 'desatribuido' : 'atribuido', actorTipo: 'equipe',
        actorId: ator.id ?? null, actorNome: ator.nome ?? null,
        payload: { de: chamado.responsavel_admin_id, para: alvo },
      });
    });
    tx();
    return alvo;
  },

  /** A trilha completa de um chamado. */
  historico(db, chamadoId) {
    const cid = exigirInteiroPositivo(chamadoId, 'chamadoId');
    return db.prepare('SELECT * FROM suporte_historico WHERE chamado_id = ? ORDER BY at, id').all(cid);
  },
};

module.exports = {
  // cliente — toda função exige tenantId
  criarChamadoDoTenant,
  buscarChamadoDoTenant,
  listarChamadosDoTenant,
  listarMensagensDoTenant,
  responderChamadoDoTenant,
  reabrirChamadoDoTenant,
  listarCategoriasAtivas,
  podeReabrir,
  DIAS_PARA_REABRIR,
  // equipe
  admin,
  // apoio
  registrarHistorico,
  STATUS_ABERTOS,
};
