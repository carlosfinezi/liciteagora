/**
 * fiscal-diagnostico-routes.js — diagnóstico fiscal do tenant.
 *
 * Responde a uma pergunta só: "o que falta para este tenant emitir corretamente?".
 * Varre identidade fiscal, cadastro de produtos, parametrização de CFOP/operação,
 * cobertura da matriz tributária e apuração, e devolve achados acionáveis.
 *
 * O que é conferido depende do REGIME. É o ponto central deste módulo: para o
 * Simples Nacional a maior parte das perguntas simplesmente não se aplica (o
 * imposto não é destacado na nota), enquanto para Lucro Real/Presumido cada item
 * sem regra é uma nota que vai ser rejeitada — ou pior, autorizada errada.
 *
 * Cada achado tem:
 *   - severidade: 'bloqueio' (não emite) | 'risco' (emite errado) | 'atencao' | 'ok'
 *   - onde: link da tela que resolve
 *   - quantos + exemplos, para não virar aviso genérico
 */

const { crtDoEmitente, ehSimples, ambitoDe, resolverRegra } = require('./fiscal-tributacao');

const LIMITE_EXEMPLOS = 8;

function existeTabela(db, nome) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(nome);
  } catch { return false; }
}

/** Consulta tolerante: tabela/coluna ausente em tenant antigo não derruba o diagnóstico. */
function q(db, sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch { return null; }
}
function q1(db, sql, ...params) {
  try { return db.prepare(sql).get(...params); } catch { return null; }
}

function achado({ id, bloco, titulo, severidade, detalhe, quantidade = null, exemplos = [], onde = null, comoResolver = null }) {
  return { id, bloco, titulo, severidade, detalhe, quantidade, exemplos: exemplos.slice(0, LIMITE_EXEMPLOS), onde, comoResolver };
}

// ─── Bloco A: identidade fiscal ─────────────────────────────────────────────
function blocoIdentidade(db, ctx) {
  const out = [];
  const emp = q1(db, 'SELECT * FROM fornecedor WHERE id = 1') || {};
  const crt = ctx.crt;

  if (!emp.regimeTributario) {
    out.push(achado({
      id: 'regime-ausente', bloco: 'Identidade fiscal',
      titulo: 'Regime tributário não informado', severidade: 'risco',
      detalhe: 'Sem regime gravado o sistema assume Simples Nacional e emite a NF-e com CRT=1. ' +
        'Se a empresa é Lucro Real ou Presumido, toda nota sai com o regime errado declarado.',
      onde: '/configuracoes/minha-empresa.html',
      comoResolver: 'Informe o regime em Minha Empresa › dados fiscais.',
    }));
  } else {
    out.push(achado({
      id: 'regime-ok', bloco: 'Identidade fiscal',
      titulo: `Regime: ${emp.regimeTributario} (CRT ${crt})`, severidade: 'ok',
      detalhe: ehSimples(crt)
        ? 'Simples Nacional: o ICMS não é destacado na nota. CSOSN é informativo e PIS/COFINS saem com CST 49 zerados.'
        : 'Regime normal: cada item precisa de CST, base e alíquota vindos da matriz de regras tributárias.',
    }));
  }

  if (!ehSimples(crt)) {
    if (emp.regimeApuracaoPISCOFINS == null || emp.regimeApuracaoPISCOFINS === '') {
      out.push(achado({
        id: 'piscofins-regime-ausente', bloco: 'Identidade fiscal',
        titulo: 'Regime de apuração de PIS/COFINS não definido', severidade: 'atencao',
        detalhe: 'Sem isto o custo de aquisição das entradas não deduz PIS/COFINS — o estoque fica ' +
          'superavaliado em quem apura pelo não-cumulativo (típico do Lucro Real).',
        onde: '/configuracoes/minha-empresa.html',
      }));
    }
    if (emp.contribuinteIPI == null) {
      out.push(achado({
        id: 'ipi-indefinido', bloco: 'Identidade fiscal',
        titulo: 'Não está definido se a empresa é contribuinte do IPI', severidade: 'atencao',
        detalhe: 'Indústria credita IPI (não entra no custo) e apura o imposto; comércio não. O ' +
          'cálculo de custo das entradas e a apuração de IPI dependem desse campo.',
        onde: '/configuracoes/minha-empresa.html',
      }));
    }
  }

  for (const [campo, rotulo] of [['cnpj', 'CNPJ'], ['razaoSocial', 'Razão social'],
    ['inscricaoEstadual', 'Inscrição estadual'], ['uf', 'UF'], ['codigoMunicipio', 'Código do município']]) {
    if (!emp[campo]) {
      out.push(achado({
        id: 'emit-' + campo, bloco: 'Identidade fiscal',
        titulo: `${rotulo} do emitente não preenchido`, severidade: 'bloqueio',
        detalhe: 'A emissão falha antes de chegar na SEFAZ.',
        onde: '/configuracoes/minha-empresa.html',
      }));
    }
  }

  const cert = q1(db, 'SELECT id FROM certificado_digital WHERE id = 1');
  if (!cert) {
    out.push(achado({
      id: 'sem-certificado', bloco: 'Identidade fiscal',
      titulo: 'Certificado digital não cadastrado', severidade: 'bloqueio',
      detalhe: 'Sem certificado A1 não há assinatura — nenhuma NF-e é emitida.',
      onde: '/fiscal/configuracao.html',
    }));
  }

  const cfg = q1(db, 'SELECT * FROM nfe_config WHERE id = 1');
  if (cfg && Number(cfg.tpAmb) === 2) {
    out.push(achado({
      id: 'ambiente-homologacao', bloco: 'Identidade fiscal',
      titulo: 'Emissão em HOMOLOGAÇÃO', severidade: 'atencao',
      detalhe: 'Notas emitidas neste ambiente não têm valor fiscal.',
      onde: '/fiscal/configuracao.html',
    }));
  }
  return out;
}

// ─── Bloco B: cadastro de produtos ──────────────────────────────────────────
function blocoProdutos(db, ctx) {
  const out = [];
  const total = (q1(db, 'SELECT COUNT(*) c FROM produtos WHERE COALESCE(ativo,1) = 1') || {}).c || 0;
  if (!total) {
    out.push(achado({
      id: 'sem-produtos', bloco: 'Produtos', titulo: 'Nenhum produto ativo cadastrado',
      severidade: 'atencao', detalhe: 'Nada a conferir no cadastro.', onde: '/estoque/produtos.html',
    }));
    return out;
  }

  const semNcm = q(db, `SELECT id, sku, descricao FROM produtos
    WHERE COALESCE(ativo,1) = 1 AND (ncm IS NULL OR TRIM(ncm) = '' OR LENGTH(REPLACE(ncm,'.','')) < 8)`) || [];
  if (semNcm.length) {
    out.push(achado({
      id: 'produtos-sem-ncm', bloco: 'Produtos',
      titulo: 'Produtos sem NCM válido', severidade: 'risco',
      quantidade: semNcm.length,
      detalhe: `${semNcm.length} de ${total} produtos ativos não têm NCM de 8 dígitos. A emissão usa ` +
        '"00000000", que a SEFAZ aceita mas é informação fiscal errada — e impede a matriz tributária ' +
        'de casar por NCM.',
      exemplos: semNcm.map(p => `${p.sku || p.id} — ${p.descricao}`),
      onde: '/classificacao-fiscal/lote.html',
      comoResolver: 'Classificação Fiscal › Classificação em lote resolve vários de uma vez.',
    }));
  }

  const semOrigem = q(db, `SELECT id, sku, descricao FROM produtos
    WHERE COALESCE(ativo,1) = 1 AND (origem IS NULL OR TRIM(origem) = '')`) || [];
  if (semOrigem.length) {
    out.push(achado({
      id: 'produtos-sem-origem', bloco: 'Produtos',
      titulo: 'Produtos sem origem da mercadoria', severidade: 'atencao',
      quantidade: semOrigem.length,
      detalhe: 'A emissão assume origem 0 (nacional). Produto importado declarado como nacional é erro fiscal.',
      exemplos: semOrigem.map(p => `${p.sku || p.id} — ${p.descricao}`),
      onde: '/estoque/produtos.html',
    }));
  }

  if (ehSimples(ctx.crt)) {
    const semCsosn = q(db, `SELECT id, sku, descricao FROM produtos
      WHERE COALESCE(ativo,1) = 1 AND (csosn IS NULL OR TRIM(csosn) = '')`) || [];
    if (semCsosn.length) {
      out.push(achado({
        id: 'produtos-sem-csosn', bloco: 'Produtos',
        titulo: 'Produtos sem CSOSN próprio', severidade: 'atencao',
        quantidade: semCsosn.length,
        detalhe: `${semCsosn.length} de ${total} caem no CSOSN do CFOP ou no genérico 400 ("não tributada ` +
          'pelo Simples"). Funciona, mas descreve a operação de forma imprecisa quando o certo seria 102 ou 500.',
        exemplos: semCsosn.map(p => `${p.sku || p.id} — ${p.descricao}`),
        onde: '/estoque/produtos.html',
      }));
    }
    const temAnexo = q1(db, "SELECT 1 FROM pragma_table_info('produtos') WHERE name = 'anexoSN'");
    if (temAnexo) {
      const semAnexo = (q1(db, `SELECT COUNT(*) c FROM produtos
        WHERE COALESCE(ativo,1) = 1 AND (anexoSN IS NULL OR TRIM(anexoSN) = '')`) || {}).c || 0;
      if (semAnexo) {
        out.push(achado({
          id: 'produtos-sem-anexo-sn', bloco: 'Produtos',
          titulo: 'Produtos sem anexo do Simples Nacional', severidade: 'atencao',
          quantidade: semAnexo,
          detalhe: 'A apuração do DAS separa receita por anexo (I comércio, II indústria). Sem isso a ' +
            'apuração joga tudo no mesmo anexo.',
          onde: '/fiscal/apuracao-sn.html',
        }));
      }
    }
  }
  return out;
}

// ─── Bloco C: CFOP e tipos de operação ──────────────────────────────────────
function blocoCfops(db) {
  const out = [];

  // CFOPs em uso (notas e pedidos) que não existem no cadastro.
  const usados = new Set();
  for (const sql of [
    'SELECT DISTINCT cfop FROM fatura_itens WHERE cfop IS NOT NULL',
    'SELECT DISTINCT cfop FROM pedido_itens WHERE cfop IS NOT NULL',
  ]) {
    (q(db, sql) || []).forEach(r => r.cfop && usados.add(String(r.cfop).trim()));
  }
  if (usados.size) {
    const lista = [...usados];
    const cadastrados = new Set((q(db,
      `SELECT codigo FROM cfops WHERE codigo IN (${lista.map(() => '?').join(',')})`, ...lista) || [])
      .map(r => String(r.codigo)));
    const orfaos = lista.filter(c => !cadastrados.has(c));
    if (orfaos.length) {
      out.push(achado({
        id: 'cfops-nao-cadastrados', bloco: 'CFOP e operações',
        titulo: 'CFOPs usados em documentos mas ausentes do cadastro', severidade: 'risco',
        quantidade: orfaos.length,
        detalhe: 'Sem cadastro, o CFOP não fornece CSOSN/CST padrão nem contrapartida de devolução — ' +
          'a emissão cai no fallback genérico.',
        exemplos: orfaos,
        onde: '/fiscal/cadastro-cfops.html',
      }));
    }
    const semPadrao = (q(db,
      `SELECT codigo, descricao FROM cfops
        WHERE codigo IN (${lista.map(() => '?').join(',')})
          AND csosnPadrao IS NULL AND cstPadrao IS NULL`, ...lista) || []);
    if (semPadrao.length) {
      out.push(achado({
        id: 'cfops-sem-padrao', bloco: 'CFOP e operações',
        titulo: 'CFOPs em uso sem CST/CSOSN padrão', severidade: 'atencao',
        quantidade: semPadrao.length,
        detalhe: 'Itens sem CSOSN no produto caem no genérico 400 quando o CFOP também não define.',
        exemplos: semPadrao.map(c => `${c.codigo} — ${c.descricao}`),
        onde: '/fiscal/cadastro-cfops.html',
      }));
    }
  }

  const opsSemCfop = q(db, `SELECT codigo, descricao FROM tipos_operacao
    WHERE ativo = 1 AND emiteNFe = 1 AND cfopInterno IS NULL AND cfopInterestadual IS NULL`) || [];
  if (opsSemCfop.length) {
    out.push(achado({
      id: 'operacoes-sem-cfop', bloco: 'CFOP e operações',
      titulo: 'Tipos de operação que emitem NF-e sem CFOP definido', severidade: 'atencao',
      quantidade: opsSemCfop.length,
      detalhe: 'A nota depende do CFOP do produto ou do fallback 5102.',
      exemplos: opsSemCfop.map(o => `${o.codigo} — ${o.descricao}`),
      onde: '/fiscal/cadastro-tipos-operacao.html',
    }));
  }
  return out;
}

// ─── Bloco D: cobertura da matriz tributária (só regime normal) ─────────────
// O achado mais valioso do diagnóstico: em vez de dizer "cadastre regras", diz
// EXATAMENTE quais combinações de produto × destino ficariam sem resposta hoje.
function blocoMatriz(db, ctx) {
  const out = [];
  if (ehSimples(ctx.crt)) {
    out.push(achado({
      id: 'matriz-nao-se-aplica', bloco: 'Matriz tributária',
      titulo: 'Matriz de regras não é necessária neste regime', severidade: 'ok',
      detalhe: 'No Simples Nacional o ICMS não é destacado na nota — não há base nem alíquota a resolver. ' +
        'A matriz só passa a ser exigida se a empresa migrar para Lucro Real ou Presumido.',
    }));
    return out;
  }

  if (!existeTabela(db, 'fiscal_regras_trib')) {
    out.push(achado({
      id: 'matriz-inexistente', bloco: 'Matriz tributária',
      titulo: 'Matriz de regras não migrada neste tenant', severidade: 'bloqueio',
      detalhe: 'A tabela fiscal_regras_trib ainda não existe — o schema novo não foi aplicado aqui.',
      onde: '/fiscal/regras-tributarias.html',
    }));
    return out;
  }

  const nRegras = (q1(db, 'SELECT COUNT(*) c FROM fiscal_regras_trib WHERE ativo = 1') || {}).c || 0;
  if (!nRegras) {
    out.push(achado({
      id: 'matriz-vazia', bloco: 'Matriz tributária',
      titulo: 'Nenhuma regra tributária cadastrada', severidade: 'bloqueio',
      detalhe: 'A empresa é de regime normal e não há regra alguma. Toda emissão vai falhar com ' +
        '"Sem regra tributária para o item".',
      onde: '/fiscal/regras-tributarias.html',
      comoResolver: 'Cadastre ao menos uma regra genérica de venda interna e use o Simular para conferir.',
    }));
    return out;
  }

  // Combinações reais: produto (NCM) × UF de destino já praticada com esse cliente.
  const combos = q(db, `
    SELECT DISTINCT p.id AS produtoId, p.sku, p.descricao, p.ncm, pe.uf AS ufDestino
      FROM fatura_itens fi
      JOIN faturas f ON f.id = fi.faturaId
      JOIN pessoas pe ON pe.id = f.clienteId
      LEFT JOIN produtos p ON p.id = fi.produtoId
     WHERE p.id IS NOT NULL AND pe.uf IS NOT NULL`) || [];

  // Se ainda não há histórico, projeta sobre os produtos ativos × UF da empresa.
  let alvo = combos;
  if (!alvo.length) {
    const ufEmp = ctx.ufEmitente;
    alvo = (q(db, `SELECT id AS produtoId, sku, descricao, ncm FROM produtos
      WHERE COALESCE(ativo,1) = 1 LIMIT 300`) || []).map(p => ({ ...p, ufDestino: ufEmp }));
  }

  const descobertos = [];
  for (const c of alvo) {
    const regra = resolverRegra(db, {
      crt: ctx.crt, tipoOperacaoId: null, cfop: null, ncm: c.ncm, produtoId: c.produtoId,
      ufOrigem: ctx.ufEmitente, ufDestino: c.ufDestino,
      ambito: ambitoDe(ctx.ufEmitente, c.ufDestino),
      tipoContribuinte: null, consumidorFinal: null,
    });
    if (!regra || !regra.cstIcms) {
      descobertos.push(`${c.sku || c.produtoId} — ${c.descricao} → ${c.ufDestino || '?'}` +
        (c.ncm ? ` (NCM ${c.ncm})` : ' (sem NCM)'));
    }
  }

  // DIFAL: sem alíquota interna da UF de destino, a venda a não contribuinte
  // fora do estado não emite. Cobra só as UFs que a empresa realmente atende.
  const ufsAtendidas = (q(db, `
    SELECT DISTINCT pe.uf FROM faturas f JOIN pessoas pe ON pe.id = f.clienteId
     WHERE pe.uf IS NOT NULL AND pe.uf <> '' AND pe.uf <> ?`, ctx.ufEmitente || '') || [])
    .map(r => String(r.uf).toUpperCase());
  if (ufsAtendidas.length) {
    const semAliq = (q(db, `SELECT uf FROM fiscal_aliquotas_uf
      WHERE aliquotaInterna IS NULL AND uf IN (${ufsAtendidas.map(() => '?').join(',')})`,
      ...ufsAtendidas) || []).map(r => r.uf);
    if (semAliq.length) {
      out.push(achado({
        id: 'difal-sem-aliquota', bloco: 'Matriz tributária',
        titulo: 'UFs atendidas sem alíquota interna cadastrada', severidade: 'risco',
        quantidade: semAliq.length,
        detalhe: 'Sem a alíquota interna do destino não há como calcular o DIFAL da venda a ' +
          'não contribuinte. A emissão para essas UFs vai parar com erro.',
        exemplos: semAliq,
        onde: '/fiscal/regras-tributarias.html',
        comoResolver: 'Regras Tributárias › Alíquotas por UF.',
      }));
    }
  }

  // Regras vencidas continuam ativas e só somem da resolução silenciosamente.
  const vencidas = q(db, `SELECT descricao, vigenciaFim FROM fiscal_regras_trib
    WHERE ativo = 1 AND vigenciaFim IS NOT NULL AND vigenciaFim < date('now','-3 hours')`) || [];
  if (vencidas.length) {
    out.push(achado({
      id: 'regras-vencidas', bloco: 'Matriz tributária',
      titulo: 'Regras ativas com vigência expirada', severidade: 'atencao',
      quantidade: vencidas.length,
      detalhe: 'Continuam ativas mas não se aplicam mais a documentos de hoje. Se não houver ' +
        'substituta, a emissão do que elas cobriam vai falhar.',
      exemplos: vencidas.map(v => `${v.descricao} (até ${v.vigenciaFim})`),
      onde: '/fiscal/regras-tributarias.html',
    }));
  }

  if (descobertos.length) {
    out.push(achado({
      id: 'matriz-sem-cobertura', bloco: 'Matriz tributária',
      titulo: 'Combinações de produto × destino sem regra aplicável', severidade: 'bloqueio',
      quantidade: descobertos.length,
      detalhe: `${descobertos.length} combinação(ões) que a empresa já pratica (ou praticaria) não têm ` +
        'regra que resolva o CST de ICMS. Cada uma é uma emissão que vai parar com erro.',
      exemplos: descobertos,
      onde: '/fiscal/regras-tributarias.html',
      comoResolver: 'Use o Simular na tela de regras com um desses casos para ver o que falta.',
    }));
  } else {
    out.push(achado({
      id: 'matriz-cobre-tudo', bloco: 'Matriz tributária',
      titulo: `${nRegras} regra(s) ativa(s) cobrem as combinações praticadas`, severidade: 'ok',
      detalhe: 'Todo produto × destino conhecido encontra uma regra com CST de ICMS.',
    }));
  }
  return out;
}

// ─── Bloco E: documentos emitidos ───────────────────────────────────────────
function blocoDocumentos(db) {
  const out = [];

  const rejeitadas = q(db, `SELECT numero, rejeicaoMotivo FROM faturas
    WHERE statusSefaz IS NOT NULL AND statusSefaz NOT IN ('autorizada','nao_fiscal','cancelada')
      AND COALESCE(excluida,0) = 0 ORDER BY id DESC LIMIT 20`) || [];
  if (rejeitadas.length) {
    out.push(achado({
      id: 'notas-rejeitadas', bloco: 'Documentos',
      titulo: 'Notas com rejeição pendente', severidade: 'risco',
      quantidade: rejeitadas.length,
      detalhe: 'Documentos que saíram do rascunho mas não foram autorizados. O número da série foi ' +
        'consumido e o financeiro pode já ter sido gerado.',
      exemplos: rejeitadas.map(f => `${f.numero}${f.rejeicaoMotivo ? ' — ' + String(f.rejeicaoMotivo).slice(0, 80) : ''}`),
      onde: '/fiscal/notas-fiscais.html',
    }));
  }

  const rascunhos = q(db, `SELECT numero, dataEmissao FROM faturas
    WHERE status = 'rascunho' AND COALESCE(excluida,0) = 0 ORDER BY id DESC LIMIT 20`) || [];
  if (rascunhos.length) {
    out.push(achado({
      id: 'rascunhos-parados', bloco: 'Documentos',
      titulo: 'Rascunhos de NF manual não emitidos', severidade: 'atencao',
      quantidade: rascunhos.length,
      detalhe: 'Rascunho não é documento fiscal e não aparece em apuração nem em DRE.',
      exemplos: rascunhos.map(f => `${f.numero} (${String(f.dataEmissao || '').slice(0, 10)})`),
      onde: '/fiscal/nova-nota.html',
    }));
  }

  const semXml = (q1(db, `SELECT COUNT(*) c FROM faturas
    WHERE statusSefaz = 'autorizada' AND (xmlAssinado IS NULL OR xmlAssinado = '')`) || {}).c || 0;
  if (semXml) {
    out.push(achado({
      id: 'autorizadas-sem-xml', bloco: 'Documentos',
      titulo: 'Notas autorizadas sem XML guardado', severidade: 'risco',
      quantidade: semXml,
      detalhe: 'A guarda do XML é obrigatória por 5 anos. Sem o arquivo não há como comprovar a operação.',
      onde: '/fiscal/fiscal-arquivamento.html',
    }));
  }
  return out;
}

// ─── Bloco F: apuração ──────────────────────────────────────────────────────
function blocoApuracao(db, ctx) {
  const out = [];

  if (ehSimples(ctx.crt)) {
    const ultima = q1(db, 'SELECT competencia, status FROM apuracoes_sn ORDER BY competencia DESC LIMIT 1');
    if (!ultima) {
      const temNota = (q1(db, "SELECT COUNT(*) c FROM faturas WHERE statusSefaz = 'autorizada'") || {}).c || 0;
      if (temNota) {
        out.push(achado({
          id: 'sn-sem-apuracao', bloco: 'Apuração',
          titulo: 'Nenhuma competência apurada', severidade: 'atencao',
          detalhe: 'Há notas autorizadas mas nenhuma apuração do Simples gerada.',
          onde: '/fiscal/apuracao-sn.html',
        }));
      }
    } else {
      out.push(achado({
        id: 'sn-apuracao-ok', bloco: 'Apuração',
        titulo: `Última apuração: ${ultima.competencia} (${ultima.status})`, severidade: 'ok',
        detalhe: 'A apuração do Simples Nacional está implementada — RBT12, anexos, faixas e DAS.',
        onde: '/fiscal/apuracao-sn.html',
      }));
    }
    return out;
  }

  // Regime normal: aqui mora o buraco. Existem os números, não existe o livro.
  const debitos = q1(db, `SELECT COUNT(*) n, COALESCE(SUM(vIcms),0) v FROM fatura_itens fi
      JOIN faturas f ON f.id = fi.faturaId
     WHERE f.statusSefaz = 'autorizada'`) || { n: 0, v: 0 };
  const creditos = q1(db, `SELECT COUNT(*) n, COALESCE(SUM(valorIcms),0) v FROM nfe_entrada_itens ei
      JOIN nfe_entrada e ON e.id = ei.nfeEntradaId
     WHERE COALESCE(e.excluida,0) = 0`) || { n: 0, v: 0 };

  // O livro existe desde 2026-08-25. O que o diagnóstico cobra agora é USO:
  // competência com movimento e sem fechamento é imposto não apurado.
  const ultima = q1(db, `SELECT competencia, status, vRecolher, saldoCredorTransportar
      FROM fiscal_apuracao_icms ORDER BY competencia DESC LIMIT 1`);
  const abertas = q(db, `SELECT competencia FROM fiscal_apuracao_icms
      WHERE status = 'aberta' ORDER BY competencia`) || [];

  if (!ultima && (debitos.n || creditos.n)) {
    out.push(achado({
      id: 'icms-nunca-apurado', bloco: 'Apuração',
      titulo: 'Nenhuma competência de ICMS apurada', severidade: 'risco',
      detalhe: `Há R$ ${Number(debitos.v).toFixed(2)} de ICMS destacado em saídas (${debitos.n} itens) e ` +
        `R$ ${Number(creditos.v).toFixed(2)} em entradas (${creditos.n} itens), e nenhuma apuração fechada. ` +
        'O livro existe — falta usá-lo.',
      onde: '/fiscal/apuracao-icms.html',
    }));
  } else if (ultima) {
    out.push(achado({
      id: 'icms-apuracao-ok', bloco: 'Apuração',
      titulo: `Última apuração de ICMS: ${ultima.competencia} (${ultima.status})`, severidade: 'ok',
      detalhe: ultima.vRecolher > 0
        ? `ICMS a recolher: R$ ${Number(ultima.vRecolher).toFixed(2)}.`
        : `Saldo credor a transportar: R$ ${Number(ultima.saldoCredorTransportar || 0).toFixed(2)}.`,
      onde: '/fiscal/apuracao-icms.html',
    }));
    if (abertas.length) {
      out.push(achado({
        id: 'icms-competencias-abertas', bloco: 'Apuração',
        titulo: 'Competências de ICMS ainda abertas', severidade: 'atencao',
        quantidade: abertas.length,
        detalhe: 'Enquanto a competência não é fechada, o saldo credor dela não é transportado ' +
          'para o mês seguinte — e a apuração do mês seguinte sai a maior.',
        exemplos: abertas.map(a => a.competencia),
        onde: '/fiscal/apuracao-icms.html',
      }));
    }
  }

  const emp = q1(db, 'SELECT regimeApuracaoPISCOFINS FROM fornecedor WHERE id = 1') || {};
  if (!emp.regimeApuracaoPISCOFINS) {
    out.push(achado({
      id: 'piscofins-sem-regime', bloco: 'Apuração',
      titulo: 'Apuração de PIS/COFINS bloqueada: regime não definido', severidade: 'risco',
      detalhe: 'Cumulativo (Lucro Presumido) e não-cumulativo (Lucro Real) produzem contas ' +
        'inteiramente diferentes — no primeiro não há crédito nenhum. Sem o campo, não há como apurar.',
      onde: '/configuracoes/minha-empresa.html',
    }));
  } else {
    const ultimaPC = q1(db, `SELECT competencia, status, regime, pisRecolher, cofinsRecolher
        FROM fiscal_apuracao_piscofins ORDER BY competencia DESC LIMIT 1`);
    const temMov = (q1(db, `SELECT COUNT(*) c FROM fatura_itens fi JOIN faturas f ON f.id = fi.faturaId
        WHERE f.statusSefaz = 'autorizada' AND (fi.vPis > 0 OR fi.vCofins > 0)`) || {}).c || 0;
    if (!ultimaPC && temMov) {
      out.push(achado({
        id: 'piscofins-nunca-apurado', bloco: 'Apuração',
        titulo: 'Nenhuma competência de PIS/COFINS apurada', severidade: 'risco',
        detalhe: `Há ${temMov} item(ns) com PIS/COFINS destacado e nenhuma apuração fechada.`,
        onde: '/fiscal/apuracao-piscofins.html',
      }));
    } else if (ultimaPC) {
      out.push(achado({
        id: 'piscofins-apuracao-ok', bloco: 'Apuração',
        titulo: `Última apuração de PIS/COFINS: ${ultimaPC.competencia} (${ultimaPC.status})`, severidade: 'ok',
        detalhe: `Regime ${ultimaPC.regime}. PIS a recolher R$ ${Number(ultimaPC.pisRecolher || 0).toFixed(2)}, ` +
          `COFINS R$ ${Number(ultimaPC.cofinsRecolher || 0).toFixed(2)}.`,
        onde: '/fiscal/apuracao-piscofins.html',
      }));
    }

    // A flag de crédito por CFOP nasce copiada da do ICMS — as regras divergem.
    const copiadas = (q1(db, `SELECT COUNT(*) c FROM cfops
        WHERE geraCreditoPisCofins IS NOT NULL AND geraCreditoPisCofins = geraCreditoIcms`) || {}).c || 0;
    const total = (q1(db, 'SELECT COUNT(*) c FROM cfops') || {}).c || 0;
    if (emp.regimeApuracaoPISCOFINS === 'nao_cumulativo' && total && copiadas === total) {
      out.push(achado({
        id: 'piscofins-credito-nao-revisado', bloco: 'Apuração',
        titulo: 'Direito a crédito de PIS/COFINS ainda não revisado por CFOP', severidade: 'atencao',
        detalhe: 'A flag de crédito de PIS/COFINS nasceu copiada da do ICMS, como ponto de partida. ' +
          'As regras não coincidem — mercadoria com ICMS-ST pode creditar PIS/COFINS se não for ' +
          'monofásica. Vale a revisão do contador antes de fechar a primeira competência.',
        onde: '/fiscal/cadastro-cfops.html',
      }));
    }
  }
  // IPI: só cobra de quem é contribuinte.
  if (Number(emp.contribuinteIPI) === 1) {
    const ultimaIpi = q1(db, `SELECT competencia, status, vRecolher, saldoCredorTransportar
        FROM fiscal_apuracao_ipi ORDER BY competencia DESC LIMIT 1`);
    const debIpi = q1(db, `SELECT COUNT(*) n FROM fatura_itens fi JOIN faturas f ON f.id = fi.faturaId
        WHERE f.statusSefaz = 'autorizada' AND fi.vIpi > 0`) || { n: 0 };
    if (!ultimaIpi && debIpi.n) {
      out.push(achado({
        id: 'ipi-nunca-apurado', bloco: 'Apuração',
        titulo: 'Nenhuma competência de IPI apurada', severidade: 'risco',
        detalhe: `Há ${debIpi.n} item(ns) com IPI destacado e nenhuma apuração fechada.`,
        onde: '/fiscal/apuracao-ipi.html',
      }));
    } else if (ultimaIpi) {
      out.push(achado({
        id: 'ipi-apuracao-ok', bloco: 'Apuração',
        titulo: `Última apuração de IPI: ${ultimaIpi.competencia} (${ultimaIpi.status})`, severidade: 'ok',
        detalhe: Number(ultimaIpi.vRecolher) > 0
          ? `IPI a recolher: R$ ${Number(ultimaIpi.vRecolher).toFixed(2)}.`
          : `Saldo credor a transportar: R$ ${Number(ultimaIpi.saldoCredorTransportar || 0).toFixed(2)}.`,
        onde: '/fiscal/apuracao-ipi.html',
      }));
    }
  }

  return out;
}

// ─── Montagem ───────────────────────────────────────────────────────────────
function gerarDiagnostico(db) {
  const crt = crtDoEmitente(db);
  const emp = q1(db, 'SELECT uf, razaoSocial, cnpj, regimeTributario FROM fornecedor WHERE id = 1') || {};
  const ctx = { crt, ufEmitente: (emp.uf || '').toUpperCase() || null };

  const achados = [
    ...blocoIdentidade(db, ctx),
    ...blocoProdutos(db, ctx),
    ...blocoCfops(db),
    ...blocoMatriz(db, ctx),
    ...blocoDocumentos(db),
    ...blocoApuracao(db, ctx),
  ];

  const contagem = { bloqueio: 0, risco: 0, atencao: 0, ok: 0 };
  achados.forEach(a => { contagem[a.severidade] = (contagem[a.severidade] || 0) + 1; });

  return {
    empresa: {
      razaoSocial: emp.razaoSocial || null, cnpj: emp.cnpj || null,
      uf: emp.uf || null, regimeTributario: emp.regimeTributario || null,
      crt, regime: ehSimples(crt) ? 'simples' : 'normal',
    },
    contagem,
    prontoParaEmitir: contagem.bloqueio === 0,
    achados,
  };
}

function registrarRotas(app, db) {
  app.get('/api/fiscal/diagnostico', (req, res) => {
    try {
      res.json({ success: true, ...gerarDiagnostico(db) });
    } catch (error) {
      console.error('[fiscal-diagnostico]', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[fiscal-diagnostico] Rotas registradas');
}

module.exports = { registrarRotasFiscalDiagnostico: registrarRotas, gerarDiagnostico };
