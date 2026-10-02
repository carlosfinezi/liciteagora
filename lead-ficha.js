/**
 * lead-ficha.js — a ficha de cadastro de um contato de lista.
 *
 * Desde 28/09 todo contato de lista tem ficha em `pessoas`, para que o
 * segmento more nela e sirva de filtro em Listas, campanhas e Conversas. Quem
 * chega por planilha (ou pela migração dos avulsos antigos) vira LEAD: ficha
 * sem documento (identificador SD-, como a da loja), `categorias = ["lead"]`,
 * o telefone da lista e o aceite de WhatsApp marcado, com a origem escrita em
 * `lgpdFonte`.
 *
 * Contato é a MESMA ficha só quando o telefone E o nome coincidem, e só entre
 * fichas de lead (decisões de 28/09). Cliente, fornecedor e demais fichas
 * antigas ficam de fora: o telefone que vem com o lead costuma ser o do
 * contador, que a Receita registra, e casar por ele punha "BECKER
 * CONTABILIDADE" no lugar de "DROGARIA SUPERFARMA". E o mesmo telefone com
 * nomes diferentes são empresas diferentes do mesmo contador: no 1bit, 278
 * telefones aparecem assim nas listas ("MEDEIROS SUPERMERCADOS" e "PARAISO DAS
 * MAQUIAGENS"). O telefone é o NORMALIZADO inteiro (55 + DDD + número), no
 * campo `telefone`, que é o que o disparo usa; o nome é comparado sem acento,
 * pontuação, espaço e caixa.
 */
'use strict';

const { normalizarDestino } = require('./comm-destinos');
const { gerarIdentificadorSemDocumento } = require('./pessoa-sem-documento');

/** O nome como chave de comparação: "Zé da Loja." e "ZE DA LOJA" são o mesmo. */
const chaveNome = (nome) => String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Map telefone normalizado → [{ id, nomes }] das fichas de lead, da mais antiga
 * à mais nova. `nomes` tem o nome fantasia e a razão social: o nome do lead
 * fica no fantasia, e a razão social é a da Receita quando a ficha foi
 * completada (scripts/completar-leads.js).
 */
function indiceDeTelefones(db) {
  const idx = new Map();
  for (const p of db.prepare(`SELECT id, telefone, razaoSocial, nomeFantasia FROM pessoas
      WHERE COALESCE(telefone,'') <> '' AND categorias LIKE '%"lead"%' ORDER BY id`).all()) {
    const d = normalizarDestino('whatsapp', p.telefone);
    if (!d) continue;
    if (!idx.has(d)) idx.set(d, []);
    idx.get(d).push({ id: p.id, nomes: [chaveNome(p.nomeFantasia), chaveNome(p.razaoSocial)].filter(Boolean) });
  }
  return idx;
}

/** As fichas de lead com este telefone e este nome (a mais antiga primeiro). */
function fichasDe(indice, destino, nome) {
  const alvo = chaveNome(String(nome || '').trim() || destino);
  return (indice.get(destino) || []).filter(f => f.nomes.includes(alvo)).map(f => f.id);
}

/** A ficha de lead deste telefone quando ela é a única com ele; senão null. */
function fichaUnicaDoTelefone(indice, destino) {
  const achadas = indice.get(destino) || [];
  return achadas.length === 1 ? achadas[0].id : null;
}

/**
 * A ficha do contato: a de lead com o mesmo telefone e nome, ou uma nova.
 * Existindo, só recebe o segmento se ainda não tiver um. `indice` é atualizado
 * com a ficha criada, para a próxima linha igual achá-la.
 * Devolve { pessoaId, criada, ambigua }.
 */
function fichaDoContato(db, indice, { destino, nome, segmentoId, nichoFunilId, fonte }) {
  const achadas = fichasDe(indice, destino, nome);
  if (achadas.length) {
    const pessoaId = achadas[0];
    if (segmentoId) db.prepare('UPDATE pessoas SET segmentoId = ? WHERE id = ? AND segmentoId IS NULL').run(segmentoId, pessoaId);
    // O nicho segue a mesma regra do segmento: completa o que está vazio e
    // nunca sobrescreve o que alguém já escolheu na ficha.
    if (nichoFunilId) db.prepare('UPDATE pessoas SET nichoFunilId = ? WHERE id = ? AND nichoFunilId IS NULL').run(nichoFunilId, pessoaId);
    return { pessoaId, criada: false, ambigua: achadas.length > 1 };
  }
  const razao = String(nome || '').trim() || destino;
  // O nome do lead vai também para o fantasia, que é de onde saem o
  // {{primeiroNome}} e o nome mostrado nas telas.
  const pessoaId = Number(db.prepare(`INSERT INTO pessoas
      (cpfCnpj, tipo, razaoSocial, nomeFantasia, telefone, ativo, semDocumento, categorias, segmentoId, nichoFunilId,
       aceitaWhatsappMarketing, lgpdFonte)
    VALUES (?, 'PF', ?, ?, ?, 1, 1, '["lead"]', ?, ?, 1, ?)`)
    .run(gerarIdentificadorSemDocumento(), razao, razao, destino, segmentoId || null, nichoFunilId || null,
      fonte || null).lastInsertRowid);
  if (!indice.has(destino)) indice.set(destino, []);
  indice.get(destino).push({ id: pessoaId, nomes: [chaveNome(razao)] });
  return { pessoaId, criada: true, ambigua: false };
}

/**
 * O lead deste telefone e nome está com "Aceita campanha por WhatsApp"
 * desmarcado? É o controle de marketing (29/09), e a campanha legado passou a
 * respeitá-lo. Só a ficha de LEAD do mesmo telefone e nome conta: a do
 * contador, que divide o telefone, não fala pelo lead.
 */
function leadRecusaMarketing(db, destino, nome) {
  const alvo = chaveNome(String(nome || '').trim() || destino);
  return db.prepare(`SELECT razaoSocial, nomeFantasia FROM pessoas
      WHERE telefone = ? AND categorias LIKE '%"lead"%' AND COALESCE(aceitaWhatsappMarketing, 0) = 0`).all(destino)
    .some(p => chaveNome(p.nomeFantasia) === alvo || chaveNome(p.razaoSocial) === alvo);
}

/**
 * O nome que as telas mostram de uma pessoa, em SQL (`alias` é o da tabela
 * pessoas na consulta). Para o lead é o nome dele, guardado no fantasia; a
 * razão social da Receita fica na ficha e nas variáveis. Para as outras
 * fichas, a razão social, como sempre foi.
 */
const nomeExibido = (alias) => `CASE WHEN ${alias}.categorias = '["lead"]'
  THEN COALESCE(NULLIF(TRIM(${alias}.nomeFantasia), ''), ${alias}.razaoSocial) ELSE ${alias}.razaoSocial END`;

module.exports = { nomeExibido, leadRecusaMarketing, chaveNome, indiceDeTelefones, fichasDe, fichaUnicaDoTelefone, fichaDoContato };
