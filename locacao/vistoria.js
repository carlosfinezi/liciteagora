/**
 * vistoria.js — saída e devolução com vistoria, apoiadas na OS.
 *
 * Nada de vistoria é construído aqui: a Fase 9.1 da OS já entrega tudo o que
 * uma locadora precisa e é isso que este módulo aciona.
 *
 *   os_tipos.checklistPadrao  → copiado NA CRIAÇÃO da OS (os-routes.js:1524),
 *                               então a OS fica imune a mudança posterior no tipo
 *   os_checklist.obrigatorio  → trava a conclusão (os-routes.js:1684-1692)
 *   os_anexos                 → as fotos da vistoria, por categoria
 *   exigeAssinaturaCliente    → assinatura no ato da entrega/devolução
 *   os_eventos                → linha do tempo
 *
 * Os dois tipos de OS são semeados de forma idempotente por `garantirTiposOS`.
 * O checklist padrão é genérico de propósito: cada locadora edita o dela na
 * tela de tipos de OS, e a edição não afeta as OS já criadas.
 */

const SLUG_ENTREGA = 'locacao-entrega';
const SLUG_DEVOLUCAO = 'locacao-devolucao';

const CHECKLIST_ENTREGA = [
  { descricao: 'Conferir estado geral e registrar fotos', obrigatorio: 1 },
  { descricao: 'Conferir acessórios e itens que acompanham', obrigatorio: 1 },
  { descricao: 'Registrar leitura do medidor (horímetro/km)', obrigatorio: 0 },
  { descricao: 'Conferir nível de combustível/carga', obrigatorio: 0 },
  { descricao: 'Orientar o cliente sobre uso e devolução', obrigatorio: 1 },
  { descricao: 'Colher assinatura do responsável pela retirada', obrigatorio: 1 },
];

const CHECKLIST_DEVOLUCAO = [
  { descricao: 'Conferir estado geral e registrar fotos', obrigatorio: 1 },
  { descricao: 'Conferir acessórios e itens que acompanham', obrigatorio: 1 },
  { descricao: 'Registrar leitura do medidor (horímetro/km)', obrigatorio: 0 },
  { descricao: 'Registrar avarias encontradas', obrigatorio: 1 },
  { descricao: 'Conferir limpeza', obrigatorio: 0 },
  { descricao: 'Colher assinatura do responsável pela devolução', obrigatorio: 1 },
];

/** Cria os dois tipos de OS se ainda não existirem. Idempotente. */
function garantirTiposOS(db) {
  const upsert = (slug, nome, descricao, checklist) => {
    const existe = db.prepare('SELECT id FROM os_tipos WHERE slug = ?').get(slug);
    if (existe) return existe.id;
    const info = db.prepare(`
      INSERT INTO os_tipos
        (nome, slug, descricao, modoFiscal, exigeAssinaturaCliente, checklistPadrao, cor, ativo)
      VALUES (?, ?, ?, 'sefaz', 1, ?, ?, 1)
    `).run(nome, slug, descricao, JSON.stringify(checklist),
           slug === SLUG_ENTREGA ? '#37b24d' : '#f59f00');
    return info.lastInsertRowid;
  };

  return {
    entregaId: upsert(SLUG_ENTREGA, 'Locação — Entrega',
      'Vistoria de saída do bem locado: estado, acessórios, medidor e assinatura.',
      CHECKLIST_ENTREGA),
    devolucaoId: upsert(SLUG_DEVOLUCAO, 'Locação — Devolução',
      'Vistoria de retorno do bem locado: estado, avarias, medidor e assinatura.',
      CHECKLIST_DEVOLUCAO),
  };
}

/** Mesma numeração do os-routes.js:424 — OS-<ano>-NNNN. */
function gerarNumeroOS(db, ano) {
  const prefix = `OS-${ano}-`;
  const u = db.prepare('SELECT numero FROM os_ordens WHERE numero LIKE ? ORDER BY id DESC LIMIT 1').get(prefix + '%');
  let n = 1;
  if (u) { const m = String(u.numero).match(/-(\d+)$/); if (m) n = parseInt(m[1], 10) + 1; }
  return prefix + String(n).padStart(4, '0');
}

/**
 * Abre a OS de vistoria de uma locação e copia o checklist do tipo.
 *
 * O INSERT é direto porque `os-routes.js` só exporta `registrarRotasOS` — não
 * há função de criação reaproveitável. O que precisa ficar igual ao caminho da
 * tela é a numeração e a cópia do checklist, e as duas estão replicadas aqui
 * de forma explícita.
 */
function abrirOSVistoria(db, contrato, momento, opts = {}) {
  const tipos = garantirTiposOS(db);
  const tipoId = momento === 'entrega' ? tipos.entregaId : tipos.devolucaoId;
  const tipo = db.prepare('SELECT * FROM os_tipos WHERE id = ?').get(tipoId);

  const ano = String(contrato.dataSaidaPrevista || '').slice(0, 4) || String(new Date().getFullYear());
  const numero = gerarNumeroOS(db, ano);
  const titulo = momento === 'entrega'
    ? `Entrega da locação ${contrato.numero}`
    : `Devolução da locação ${contrato.numero}`;

  const info = db.prepare(`
    INSERT INTO os_ordens
      (numero, clienteId, titulo, status, tipoId, observacoes,
       enderecoExecucao, usuarioCriacao)
    VALUES (?, ?, ?, 'aberta', ?, ?, ?, ?)
  `).run(numero, contrato.clienteId, titulo, tipoId,
         `Gerada automaticamente pelo módulo de Locação (${contrato.numero}).`,
         contrato.enderecoEntrega || null, opts.usuario || null);

  const osId = info.lastInsertRowid;

  // Copy-on-create, igual ao os-routes.js:1524 — a OS não muda se o tipo mudar.
  try {
    const itens = JSON.parse(tipo.checklistPadrao || '[]') || [];
    const stmt = db.prepare(
      'INSERT INTO os_checklist (osId, ordem, descricao, obrigatorio) VALUES (?, ?, ?, ?)'
    );
    itens.forEach((it, i) => stmt.run(osId, i, it.descricao, it.obrigatorio ? 1 : 0));
  } catch (_) { /* checklist malformado no tipo não impede a OS */ }

  try {
    db.prepare(`INSERT INTO os_eventos (osId, tipo, descricao, usuario)
                VALUES (?, 'criada', ?, ?)`)
      .run(osId, `Vistoria de ${momento} da locação ${contrato.numero}`, opts.usuario || null);
  } catch (_) { /* os_eventos é opcional para o fluxo */ }

  return db.prepare('SELECT id, numero, status, tipoId FROM os_ordens WHERE id = ?').get(osId);
}

/**
 * Checklist obrigatório 100% concluído? Espelha a trava do os-routes.js:1686.
 * Devolve a lista de pendências (vazia = pode seguir).
 */
function pendenciasChecklist(db, osId) {
  if (!osId) return [];
  try {
    return db.prepare(
      'SELECT id, descricao FROM os_checklist WHERE osId = ? AND obrigatorio = 1 AND concluido = 0'
    ).all(osId);
  } catch (_) {
    return [];
  }
}

module.exports = {
  SLUG_ENTREGA,
  SLUG_DEVOLUCAO,
  CHECKLIST_ENTREGA,
  CHECKLIST_DEVOLUCAO,
  garantirTiposOS,
  gerarNumeroOS,
  abrirOSVistoria,
  pendenciasChecklist,
};
