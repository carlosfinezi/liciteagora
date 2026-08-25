// feature-gate.js
//
// Barra rotas de modulos pagos usando a MESMA flag por tenant que o menu le
// (`<feature>_enabled` na tabela `config`, ver features-routes.js). Ligar ou
// desligar um modulo no admin passa a valer para a tela E para a API de uma
// vez, sem segunda fonte de verdade para manter em sincronia.
//
// Por que nao o module-gate.js: aquele resolve slugs de PLANO (tier +
// overrides) e esta DESATIVADO no server.js desde 2026-05-21, apos duas
// tentativas causarem travamento prolongado com causa raiz nao identificada.
// Aqui a leitura e um SELECT por request no db do tenant — o mesmo custo que
// qualquer handler ja paga — e o escopo e so o prefixo declarado.
//
// AUSENCIA da chave conta como DESLIGADO: modulo pago entra por opt-in.
//
// Criterio para entrar neste mapa: TODAS as telas que consomem o prefixo
// pertencem a uma unica feature. Prefixo compartilhado por dois modulos fica
// de fora — negar um quebraria o outro. Os casos deixados de fora estao
// documentados em GATES_FORA, no fim do arquivo.

const GATES = [
  // Operacional (propostas, lances automaticos, monitor de chat)
  { prefixo: '/api/lance', feature: 'operacional', rotulo: 'Operacional' },

  // Varejo (PDV, TEF, marketplaces). NFC-e NAO entra aqui — ver GATES_FORA.
  { prefixo: '/api/pdv', feature: 'varejo', rotulo: 'Varejo' },
  { prefixo: '/api/tef', feature: 'varejo', rotulo: 'Varejo' },
  { prefixo: '/api/marketplaces', feature: 'varejo', rotulo: 'Varejo' },

  // Fiscal (NF-e, MDF-e, CT-e). O match do Express e por segmento, entao
  // '/api/nfe' NAO captura '/api/nfe-entrada' (manifestador) — que tambem e
  // fiscal, mas fica livre por nao estar declarado aqui.
  { prefixo: '/api/nfe', feature: 'fiscal', rotulo: 'Fiscal' },
  { prefixo: '/api/mdfe', feature: 'fiscal', rotulo: 'Fiscal' },
  { prefixo: '/api/cte', feature: 'fiscal', rotulo: 'Fiscal' },

  // Classificacao Fiscal (add-on NCM/CEST). Os prefixos sao especificos de
  // proposito: as demais rotas /api/fiscal/* (apuracao, retencoes, tabelas,
  // socios, xmls) sao do modulo Fiscal comum e seguem livres.
  { prefixo: '/api/fiscal/ncm', feature: 'classificacao_fiscal', rotulo: 'Classificação Fiscal' },
  { prefixo: '/api/fiscal/cest', feature: 'classificacao_fiscal', rotulo: 'Classificação Fiscal' },
  { prefixo: '/api/fiscal/classificacao', feature: 'classificacao_fiscal', rotulo: 'Classificação Fiscal' },
  { prefixo: '/api/fiscal/relatorio', feature: 'classificacao_fiscal', rotulo: 'Classificação Fiscal' },

  // Contabilidade (escrituracao por partida dobrada)
  { prefixo: '/api/contabilidade', feature: 'contabilidade', rotulo: 'Contabilidade' },

  // ---- Segunda leva (2026-08-25) ----
  // Derivados cruzando perfis-api-map.MAPA (prefixo -> paginas) com a feature
  // de cada pagina, e conferidos contra o consumo REAL no front. Entrou so
  // prefixo cujas telas consumidoras vivem todas no diretorio de um unico
  // modulo. Ver GATES_FORA para o que foi barrado e por que.

  // Comercial
  { prefixo: '/api/devolucoes', feature: 'comercial', rotulo: 'Comercial' },
  { prefixo: '/api/fornecedor-integracoes', feature: 'comercial', rotulo: 'Comercial' },
  { prefixo: '/api/metas', feature: 'comercial', rotulo: 'Comercial' },
  { prefixo: '/api/precos', feature: 'comercial', rotulo: 'Comercial' },
  { prefixo: '/api/tabelas-preco', feature: 'comercial', rotulo: 'Comercial' },
  { prefixo: '/api/transportadoras', feature: 'comercial', rotulo: 'Comercial' },
  { prefixo: '/api/vendas-perdidas', feature: 'comercial', rotulo: 'Comercial' },
  // SSL mora em public/comercial/ mas e add-on proprio: o item do menu declara
  // `feature: 'ssl'`. Gatear por 'comercial' liberaria para quem nao contratou.
  { prefixo: '/api/ssl', feature: 'ssl', rotulo: 'Certificados SSL' },

  // Comunicação / WhatsApp — duas features na mesma seção do menu, cada
  // prefixo segue a do seu próprio consumidor.
  { prefixo: '/api/audit-log', feature: 'comunicacao', rotulo: 'Comunicação' },
  { prefixo: '/api/emails', feature: 'comunicacao', rotulo: 'Comunicação' },
  { prefixo: '/api/comm', feature: 'comunicacao', rotulo: 'Comunicação' },
  { prefixo: '/api/conversas', feature: 'whatsapp', rotulo: 'WhatsApp' },
  { prefixo: '/api/whatsapp', feature: 'whatsapp', rotulo: 'WhatsApp' },
  { prefixo: '/api/wa-campanhas', feature: 'whatsapp', rotulo: 'WhatsApp' },
  { prefixo: '/api/ia', feature: 'whatsapp', rotulo: 'WhatsApp' },

  // Financeiro. /api/mp e /api/boletos sao telas: o webhook do provedor cai em
  // /api/webhooks/mercadopago, que esta em LIBERADOS e fora destes prefixos —
  // baixa automatica de pagamento nao passa por aqui.
  { prefixo: '/api/adiantamentos', feature: 'financeiro', rotulo: 'Financeiro' },
  { prefixo: '/api/boleto-provedores', feature: 'financeiro', rotulo: 'Financeiro' },
  { prefixo: '/api/boletos', feature: 'financeiro', rotulo: 'Financeiro' },
  { prefixo: '/api/cartoes', feature: 'financeiro', rotulo: 'Financeiro' },
  { prefixo: '/api/conciliacao', feature: 'financeiro', rotulo: 'Financeiro' },
  { prefixo: '/api/cp-categorias', feature: 'financeiro', rotulo: 'Financeiro' },
  { prefixo: '/api/cp-recorrencias', feature: 'financeiro', rotulo: 'Financeiro' },
  { prefixo: '/api/cr-categorias', feature: 'financeiro', rotulo: 'Financeiro' },
  { prefixo: '/api/fluxo-caixa', feature: 'financeiro', rotulo: 'Financeiro' },
  { prefixo: '/api/gerencial', feature: 'financeiro', rotulo: 'Financeiro' },
  { prefixo: '/api/lotes-pagamento', feature: 'financeiro', rotulo: 'Financeiro' },
  { prefixo: '/api/mp', feature: 'financeiro', rotulo: 'Financeiro' },
  { prefixo: '/api/provisoes', feature: 'financeiro', rotulo: 'Financeiro' },
  { prefixo: '/api/recorrencias', feature: 'financeiro', rotulo: 'Financeiro' },
  { prefixo: '/api/renegociacoes', feature: 'financeiro', rotulo: 'Financeiro' },

  // Fiscal
  { prefixo: '/api/cfops-entrada-map', feature: 'fiscal', rotulo: 'Fiscal' },
  { prefixo: '/api/dre', feature: 'fiscal', rotulo: 'Fiscal' },
  { prefixo: '/api/fiscal-regras', feature: 'fiscal', rotulo: 'Fiscal' },
  { prefixo: '/api/gnre', feature: 'fiscal', rotulo: 'Fiscal' },
  { prefixo: '/api/nf-avulsa', feature: 'fiscal', rotulo: 'Fiscal' },
  { prefixo: '/api/nfe-entrada', feature: 'fiscal', rotulo: 'Fiscal' },
  { prefixo: '/api/notas-fiscais', feature: 'fiscal', rotulo: 'Fiscal' },

  // Operacional (licitações). Os session-services (BLL/BNC/PCP) não chamam
  // estas rotas — a comunicação deles com o server não é HTTP.
  { prefixo: '/api/bll', feature: 'operacional', rotulo: 'Operacional' },
  { prefixo: '/api/bnc', feature: 'operacional', rotulo: 'Operacional' },
  { prefixo: '/api/pcp', feature: 'operacional', rotulo: 'Operacional' },
  { prefixo: '/api/conexao', feature: 'operacional', rotulo: 'Operacional' },
  { prefixo: '/api/integracoes', feature: 'operacional', rotulo: 'Operacional' },
  { prefixo: '/api/produto-match', feature: 'operacional', rotulo: 'Operacional' },
  { prefixo: '/api/propostas', feature: 'operacional', rotulo: 'Operacional' },
  { prefixo: '/api/relatorio-lances', feature: 'operacional', rotulo: 'Operacional' },
  { prefixo: '/api/tarefas', feature: 'operacional', rotulo: 'Operacional' },
  { prefixo: '/api/telegram', feature: 'operacional', rotulo: 'Operacional' },

  // Ordens de Serviço. O portal do cliente usa /api/portal/* (liberado).
  { prefixo: '/api/equipamentos', feature: 'os', rotulo: 'Ordens de Serviço' },
  { prefixo: '/api/os-tipos', feature: 'os', rotulo: 'Ordens de Serviço' },
  { prefixo: '/api/servicos', feature: 'os', rotulo: 'Ordens de Serviço' },

  // Patrimônio
  { prefixo: '/api/patrimonio', feature: 'patrimonio', rotulo: 'Patrimônio' },

  // Catálogo / Estoque / Compras (feature `produtos`)
  { prefixo: '/api/cotacoes', feature: 'produtos', rotulo: 'Catálogo, Estoque & Compras' },
  { prefixo: '/api/etiquetas', feature: 'produtos', rotulo: 'Catálogo, Estoque & Compras' },
  { prefixo: '/api/integracao-tipos', feature: 'produtos', rotulo: 'Catálogo, Estoque & Compras' },
  { prefixo: '/api/inventarios', feature: 'produtos', rotulo: 'Catálogo, Estoque & Compras' },
  { prefixo: '/api/necessidades-compra', feature: 'produtos', rotulo: 'Catálogo, Estoque & Compras' },
  { prefixo: '/api/pedidos-compra', feature: 'produtos', rotulo: 'Catálogo, Estoque & Compras' },
  { prefixo: '/api/produto-lookup', feature: 'produtos', rotulo: 'Catálogo, Estoque & Compras' },
  { prefixo: '/api/requisicoes', feature: 'produtos', rotulo: 'Catálogo, Estoque & Compras' },
  { prefixo: '/api/reservas', feature: 'produtos', rotulo: 'Catálogo, Estoque & Compras' },
  { prefixo: '/api/transferencias', feature: 'produtos', rotulo: 'Catálogo, Estoque & Compras' },

  // RH
  { prefixo: '/api/comissoes', feature: 'rh', rotulo: 'RH' },

  // Varejo
  { prefixo: '/api/romaneios', feature: 'varejo', rotulo: 'Varejo' },
];

// Prefixos que NAO entram, e o motivo. Documentado para que a proxima pessoa
// nao os adicione achando que foram esquecidos.
const GATES_FORA = [
  // Compartilhados por DUAS OU MAIS features — negar um quebra o outro:
  //   /api/nfce         fiscal (notas-fiscais, configuracao) + varejo (pdv)
  //   /api/bi           licitacoes (consulta) + operacional (inteligencia)
  //   /api/crm          comercial + licitacoes
  //   /api/compras      produtos + comercial
  //   /api/estoque      produtos + fiscal
  //   /api/faturas      comercial + fiscal
  //   /api/fornecedores produtos + financeiro + comercial + os
  //   /api/depositos    produtos + comercial + os
  //   /api/adquirentes  financeiro + comercial
  //   /api/cfops        comercial + fiscal
  //   /api/financeiro   financeiro + cobranca
  //   /api/fiscal       fiscal + classificacao_fiscal + financeiro + os
  //   /api/funcionarios rh + varejo
  //   /api/grupos-palavras  operacional + licitacoes
  //   /api/habilitacao  habilitacao + operacional
  //   /api/optica       optica + produtos
  //   /api/politicas-prazo  financeiro + comercial + os
  //   /api/nfse         fiscal + comunicacao
  //
  // Consumidos por tela SEM feature (Configuracoes, dashboard, portal publico,
  // loja) ou por .js compartilhado — gatear derrubaria tela de todo tenant:
  //   /api/alcadas, /api/alertas, /api/analise, /api/centros-custo, /api/cep,
  //   /api/certificado, /api/chat, /api/cnpj, /api/cobrancas, /api/comprasnet,
  //   /api/config, /api/contas-a-pagar, /api/contas-a-receber,
  //   /api/contas-financeiras, /api/contratos, /api/credenciais, /api/fornecedor,
  //   /api/govbr, /api/importacao, /api/interesse, /api/interesses,
  //   /api/licitacoes, /api/lida, /api/lidas, /api/os, /api/pdf, /api/pedidos,
  //   /api/pessoas, /api/plano-contas, /api/produtos, /api/proposta,
  //   /api/relatorios, /api/sem-interesse, /api/smtp, /api/sniper, /api/status,
  //   /api/sync, /api/valores-proposta
  //
  // Sem consumidor no front (job, integracao externa ou rota morta) — sem como
  // provar quem chama, nao entram:
  //   /api/agenda, /api/cfops-regras, /api/fornecedores-documentos, /api/orgaos,
  //   /api/relatorio-concorrentes, /api/rh, /api/robo, /api/sc,
  //   /api/timeline-lances
  //
  // Tudo em LIBERADOS (perfis-api-map) fica fora por definicao: auth, portal
  // publico, loja, webhooks, control-plane, /api/features, /api/user.
];

function featureLigada(db, feature) {
  try {
    const row = db.prepare('SELECT valor FROM config WHERE chave = ?').get(feature + '_enabled');
    return !!(row && row.valor === '1');
  } catch (_) {
    return false; // tenant sem tabela config / fora de contexto: nega
  }
}

// `db` e o Proxy tenant-aware (tenant-middleware.createDbProxy): dentro de uma
// request ele ja aponta para o banco do tenant certo.
function registrarFeatureGates(app, db) {
  for (const { prefixo, feature, rotulo } of GATES) {
    app.use(prefixo, (req, res, next) => {
      if (featureLigada(db, feature)) return next();
      res.status(403).json({
        success: false,
        error: `Módulo ${rotulo} não está habilitado para esta empresa.`,
      });
    });
  }
  console.log(`[FeatureGate] ${GATES.length} prefixos protegidos por flag de tenant`);
}

module.exports = { registrarFeatureGates, GATES, GATES_FORA, featureLigada };
