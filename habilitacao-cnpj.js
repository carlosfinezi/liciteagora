// habilitacao-cnpj.js
//
// Regra de licitação para CERTIDÕES em ambiente multi-loja (matriz + filiais).
//
// Fundamento jurídico (pesquisa 2026-07-14):
//   - Quem participa do certame apresenta a regularidade fiscal no PRÓPRIO CNPJ.
//   - Certidões de ÂMBITO DA PESSOA JURÍDICA (nível federal: CND Federal RFB/PGFN,
//     CRF/FGTS e CNDT trabalhista) cobrem matriz + filiais e, para uma FILIAL da
//     MESMA PJ, saem no CNPJ da MATRIZ (INSS/FGTS/tributos federais são
//     arrecadados de forma centralizada/unificada).
//   - Certidões ESTADUAL e MUNICIPAL são por estabelecimento → CNPJ próprio.
//   - Empresa juridicamente DISTINTA (PJ_DISTINTA) habilita-se sozinha em tudo.
//
// A `esfera` do documento decide: 'federal' = âmbito da PJ; 'estadual'/'municipal'
// = próprio estabelecimento.

const _COLS = 'cnpj, inscricaoEstadual, inscricaoMunicipal, cidade, codigoMunicipio';

function _matriz(db) {
  return db.prepare(`SELECT ${_COLS} FROM fornecedor WHERE id = 1`).get()
      || db.prepare(`SELECT ${_COLS} FROM estabelecimentos WHERE matriz = 1`).get()
      || {};
}

function _ctx(src, extra) {
  return {
    cnpj: src.cnpj || null,
    inscricaoEstadual: src.inscricaoEstadual || null,
    inscricaoMunicipal: src.inscricaoMunicipal || null,
    cidade: src.cidade || null,
    codigoMunicipio: src.codigoMunicipio || null,
    ...extra
  };
}

// Resolve o cadastro (CNPJ/IE/IM/cidade) a usar na certidão de um documento de
// habilitação, aplicando a herança matriz↔filial. `herdadoDaMatriz=true` sinaliza
// à UI que a certidão daquela filial sai, legalmente, no CNPJ da matriz.
function cnpjIeParaCertidao(db, estabelecimentoId, esfera) {
  const daMatriz = () => _ctx(_matriz(db), { herdadoDaMatriz: false, escopo: 'matriz' });

  if (!estabelecimentoId) return daMatriz();

  const estab = db.prepare(
    `SELECT id, matriz, tipo_vinculo, ${_COLS} FROM estabelecimentos WHERE id = ?`
  ).get(estabelecimentoId);
  if (!estab || estab.matriz) return daMatriz();

  // Filial: certidão FEDERAL da MESMA PJ herda o cadastro da matriz.
  if (estab.tipo_vinculo === 'FILIAL_MESMA_PJ' && String(esfera).toLowerCase() === 'federal') {
    return _ctx(_matriz(db), { herdadoDaMatriz: true, escopo: 'matriz-herdado' });
  }

  // Estadual/municipal, ou empresa distinta: cadastro próprio do estabelecimento.
  return _ctx(estab, { herdadoDaMatriz: false, escopo: 'proprio' });
}

module.exports = { cnpjIeParaCertidao };
