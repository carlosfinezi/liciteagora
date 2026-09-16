/**
 * nfe-med-rastro.js — Grupos <med> e <rastro> do item de medicamento na
 * NFC-e/NF-e (NT 2021.004).
 *
 * POR QUE ISTO EXISTE
 * A lib que monta o XML (`node-sped-nfe`) DECLARA os dois métodos e não
 * implementa nenhum: `tagRastro` e `tagMed` são, literalmente,
 * `throw "não implementado!"` (dist/utils/make.js:197-205). E as saídas óbvias
 * estão fechadas neste ambiente: `npm install` é negado e patch em
 * node_modules some no próximo install.
 *
 * COMO RESOLVE
 * Injeta os dois grupos no XML já montado, ANTES da assinatura. O ponto é
 * exatamente este, em nfce-routes.js:
 *
 *     const xmlRaw = NFe.xml();
 *     const xmlComMed = injetarMedRastro(xmlRaw, dados);   // <-- aqui
 *     const xmlAssinado = await tools.xmlSign(xmlComMed);
 *
 * É seguro por construção: a assinatura é calculada depois, sobre o XML já
 * completo.
 *
 * POR QUE INSERÇÃO DE TEXTO E NÃO ROUND-TRIP DE PARSER
 * O plano previa `fast-xml-parser`, por causa da ordem rígida dos filhos de
 * <prod>. Ao ver o XML que a lib gera, a inserção de texto ficou tanto mais
 * segura quanto igualmente correta:
 *
 *   - <prod> termina em <indTot>, e no layout 4.00 `rastro` e `med` são
 *     justamente os últimos filhos de <prod> (…indTot, DI, detExport, xPed,
 *     nItemPed, nFCI, rastro*, med). Inserir antes de </prod> JÁ produz a
 *     ordem do schema.
 *   - Reserializar o documento inteiro num parser arriscaria coerção de
 *     valores num XML que vai ser assinado: "1.0000" viraria 1, "0001" viraria
 *     1, e a nota quebra de um jeito difícil de enxergar.
 *
 * Nada fora dos <prod> de medicamento é tocado.
 */

// NCM de medicamento segundo a NT 2021.004: capítulos 3001 a 3006.
function ehNcmMedicamento(ncm) {
  const n = String(ncm || '').replace(/\D/g, '');
  return /^300[1-6]/.test(n);
}

function escaparXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// A SEFAZ recusa data fora de AAAA-MM-DD. Lote com data em outro formato é
// erro de cadastro e precisa aparecer aqui, não na rejeição.
function formatarData(d, campo, contexto) {
  const s = String(d || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`${contexto}: ${campo} inválida ("${d}") — esperado AAAA-MM-DD`);
  }
  return s;
}

/**
 * Monta os dados dos grupos a partir do catálogo e dos lotes já resolvidos
 * pelo FEFO. Lança erro com o que falta — de propósito, ANTES de a nota ir à
 * SEFAZ: rejeição 840 de volta é caro de diagnosticar; a mesma falta detectada
 * aqui é uma linha na tela do balcão.
 *
 * `itens`         — itens da venda, na mesma ordem do XML
 * `lotesDaVenda`  — saída de fefo.resolverLotesDaVenda (mesma ordem)
 */
function montarDadosMedicamento(db, itens, lotesDaVenda) {
  const dados = [];
  const erros = [];

  itens.forEach((it, i) => {
    if (!ehNcmMedicamento(it.ncm)) return;

    const nome = it.descricao || it.sku || `item ${i + 1}`;
    const spec = it.produtoId
      ? db.prepare('SELECT * FROM farmacia_medicamento_specs WHERE produtoId = ?').get(it.produtoId)
      : null;

    if (!spec) {
      erros.push(`${nome}: NCM de medicamento sem cadastro farmacêutico — importe a lista CMED ou preencha o registro ANVISA`);
      return;
    }

    // cProdANVISA: registro, ou 'ISENTO' + motivo. A NT não aceita meio-termo.
    let cProdANVISA = null, motivo = null;
    if (Number(spec.isentoRegistro)) {
      motivo = String(spec.motivoIsencao || '').trim();
      if (!motivo) {
        erros.push(`${nome}: isento de registro ANVISA sem o motivo da isenção`);
        return;
      }
      cProdANVISA = 'ISENTO';
    } else {
      const reg = String(spec.registroAnvisa || '').replace(/\D/g, '');
      if (!reg) {
        erros.push(`${nome}: sem registro ANVISA (e não marcado como isento)`);
        return;
      }
      cProdANVISA = reg;
    }

    if (spec.pmc == null) {
      erros.push(`${nome}: sem PMC — a NF-e exige o preço máximo ao consumidor no grupo med`);
      return;
    }
    const vPMC = Number(spec.pmc);

    // rastro: um por lote que saiu. Medicamento sem lote não vai para a SEFAZ.
    const alocacoes = lotesDaVenda?.[i]?.alocacoes || [];
    if (!alocacoes.length) {
      erros.push(`${nome}: medicamento sem lote na saída — o grupo rastro é obrigatório`);
      return;
    }

    const rastro = [];
    for (const a of alocacoes) {
      if (!a.numero) { erros.push(`${nome}: lote sem número`); return; }
      if (!a.dataValidade) { erros.push(`${nome}: lote ${a.numero} sem data de validade`); return; }
      rastro.push({
        nLote: String(a.numero).slice(0, 20),
        qLote: Number(a.quantidade).toFixed(3),
        // dFab é obrigatório no grupo; sem data de fabricação cadastrada, a
        // própria validade é o melhor dado disponível e mantém a nota válida.
        dFab: formatarData(a.dataFabricacao || a.dataValidade, 'data de fabricação', `${nome} · lote ${a.numero}`),
        dVal: formatarData(a.dataValidade, 'data de validade', `${nome} · lote ${a.numero}`),
      });
    }

    dados.push({
      indice: i,
      rastro,
      med: { cProdANVISA, xMotivoIsencao: motivo, vPMC: vPMC.toFixed(2) },
    });
  });

  if (erros.length) {
    const e = new Error('Medicamento sem dado obrigatório para a NF-e:\n· ' + erros.join('\n· '));
    e.detalhes = erros;
    throw e;
  }
  return dados;
}

function montarXmlRastro(r) {
  return `<rastro><nLote>${escaparXml(r.nLote)}</nLote><qLote>${r.qLote}</qLote>`
    + `<dFab>${r.dFab}</dFab><dVal>${r.dVal}</dVal></rastro>`;
}

function montarXmlMed(m) {
  let s = `<med><cProdANVISA>${escaparXml(m.cProdANVISA)}</cProdANVISA>`;
  if (m.xMotivoIsencao) s += `<xMotivoIsencao>${escaparXml(m.xMotivoIsencao).slice(0, 255)}</xMotivoIsencao>`;
  s += `<vPMC>${m.vPMC}</vPMC></med>`;
  return s;
}

/**
 * Insere os grupos nos itens indicados. `dados` vem de montarDadosMedicamento.
 * Devolve o XML novo; se não houver medicamento, devolve o mesmo XML.
 */
function injetarMedRastro(xml, dados) {
  if (!dados || !dados.length) return xml;
  const porIndice = new Map(dados.map(d => [d.indice, d]));

  let i = -1;
  let substituidos = 0;
  const novo = xml.replace(/<det\b[^>]*>[\s\S]*?<\/det>/g, (bloco) => {
    i++;
    const d = porIndice.get(i);
    if (!d) return bloco;
    const fim = bloco.indexOf('</prod>');
    if (fim < 0) return bloco;
    const inserir = d.rastro.map(montarXmlRastro).join('') + montarXmlMed(d.med);
    substituidos++;
    return bloco.slice(0, fim) + inserir + bloco.slice(fim);
  });

  if (substituidos !== dados.length) {
    // Falhar alto: XML em formato inesperado com medicamento na nota vira
    // rejeição 840 lá na frente, e aí ninguém liga uma coisa à outra.
    throw new Error(`Injeção dos grupos med/rastro falhou: ${substituidos} de ${dados.length} itens`);
  }
  return novo;
}

module.exports = {
  ehNcmMedicamento,
  montarDadosMedicamento,
  injetarMedRastro,
  montarXmlMed,
  montarXmlRastro,
  formatarData,
};
