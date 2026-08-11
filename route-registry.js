/**
 * route-registry.js
 * ------------------------------------------------------------------
 * Extraído do server.js (NFSE-M06 onda 6.36, 2026-04-20).
 *
 * Centraliza ~55 registros de rotas PROTEGIDAS (pós requireAuth) e os
 * wrappers enviarTelegram / enviarNotificacaoTelegram que só são
 * consumidos por elas. registerProtectedRoutes(app, deps) é chamada uma
 * vez pelo server.js logo após a barreira de autenticação e após os
 * arquivos estáticos protegidos.
 *
 * Ordem interna preservada 1:1 com o server.js anterior — algumas
 * rotas dependem de ordem de registro para decidir quem vence em caso
 * de path collision (p.ex. /api/analise/stats aparece nos blocos A e B
 * de analise-ia-routes; o último registro vence).
 *
 * Monitoramento server-side via Puppeteer foi removido (2026-04-22):
 * captura de mensagens do Comprasnet agora é 100% Electron standalone
 * (sync via /api/sync/mensagens-global). govbr-routes.js virou CRUD
 * puro do config (CPF/senha isolado por tenant).
 *
 * Deps esperadas (desestruturadas do options object):
 *   db, dbPath, PORT,
 *   pncpSync, salvarItens,
 *   PNCP_API_BASE, PNCP_API_ITENS,
 *   getConfigValue, setConfigValue, getIAKeys.
 *
 * Notas:
 *   - registrarRotasPortalAdmin vem de ./portal-routes (mesmo módulo
 *     que o Portal público registrado pré-auth no server.js). Node cacheia
 *     o require; não há custo em re-importar.
 *   - agendarJornal / agendarRecorrencias / agendarCobrancas /
 *     agendarPollingBoletos / iniciarReconciliadorS6 NÃO são registrados
 *     aqui — ficam em server.js porque são passados para createRoleDispatch
 *     (o master-only pode chamá-los sem Express).
 */

const { registrarRotasUsuarios } = require('./usuarios-routes');
const { registrarRotasAuditoria } = require('./audit-log');
const { registrarRotasDevolucoes } = require('./devolucoes-routes');
const { registrarRotasCrm } = require('./crm-routes');
const { registrarRotasGerencial } = require('./gerencial-routes');
const { registrarRotasConciliacao } = require('./conciliacao-routes');
const { registrarRotasComissoes } = require('./comissoes-routes');
const { registrarRotasContratos } = require('./contratos-routes');
const { registrarRotasHabilitacao } = require('./habilitacao-routes');
const { registrarRotasComprasnetAnexos } = require('./comprasnet-anexos-routes');
const { registrarRotasOS } = require('./os-routes');
const { registrarRotasComm } = require('./comm-routes');
const { registrarRotasMDFe } = require('./mdfe-routes');
const { registrarRotasRH } = require('./rh-routes');
const { registrarRotasPatrimonio } = require('./patrimonio-routes');
const { registrarRotasRoteirizacao } = require('./roteirizacao-routes');
const { registrarRotasCTe } = require('./cte-routes');
const { registrarRotasMarketplaces } = require('./marketplaces-routes');
const { registrarRotasTEF } = require('./tef-routes');
const { registrarRotasLicitacoes } = require('./licitacoes-routes');
const { registrarRotasGovBr } = require('./govbr-routes');
const { registrarRotasSniper } = require('./sniper-lance-routes');
const { registrarRotasNfse } = require('./nfse-routes');
const { registrarRotasFinanceiro } = require('./financeiro-routes');
const { registrarRotasRecorrencia } = require('./recorrencia-routes');
const { registrarRotasProdutos } = require('./produtos-routes');
const { registrarRotasProdutoLookup } = require('./produto-lookup-routes');
const { registrarRotasProdutoMatch } = require('./produto-match-routes');
const { registrarRotasFornecedores } = require('./fornecedores-routes');
const { registrarRotasEstoque } = require('./estoque-routes');
const { registrarRotasDepositos } = require('./depositos-routes');
const { registrarRotasEtiquetas } = require('./etiquetas-routes');
const { registrarRotasFinanceiroAvancado } = require('./financeiro-avancado-routes');
const { registrarRotasCotacoes } = require('./cotacoes-routes');
const { registrarRotasContabilidade } = require('./contabilidade-routes');
const { registrarRotasRequisicoes } = require('./requisicoes-routes');
const { registrarRotasPrecos } = require('./precos-routes');
const { registrarRotasFiscalOps } = require('./fiscal-ops-routes');
const { registrarRotasGovernanca } = require('./governanca-routes');
const { registrarRotasTesouraria } = require('./tesouraria-routes');
const { registrarRotasPlanejamento } = require('./planejamento-routes');
const { registrarRotasContabilizacao } = require('./contabilizacao-routes');
const { registrarRotasIbsCbs } = require('./ibscbs-routes');
const { registrarRotasLotes } = require('./lotes-routes');
const { registrarRotasSerial } = require('./serial-routes');
const { registrarRotasReservas } = require('./reservas-routes');
const { registrarRotasInventario } = require('./inventario-routes');
const { registrarRotasCompras } = require('./compras-routes');
const { registrarRotasPedidos } = require('./pedidos-routes');
const { registrarRotasFaturas } = require('./faturas-routes');
const { registrarRotasContasFinanceiras } = require('./contas-financeiras-routes');
const { registrarRotasNfeEmit } = require('./nfe-emit-routes');
const { registrarRotasNfeEntrada } = require('./nfe-entrada-routes');
const { registrarRotasContasPagar } = require('./contas-pagar-routes');
const { registrarRotasContasReceber } = require('./contas-receber-routes');
const { registrarRotasFluxoCaixa } = require('./fluxo-caixa-routes');
const { registrarRotasFiscalSN } = require('./fiscal-sn-routes');
const { registrarRotasLivroCaixa } = require('./livro-caixa-routes');
const { registrarRotasFiscalArquivamento } = require('./fiscal-arquivamento-routes');
const { registrarRotasRetencoes } = require('./retencoes-routes');
const { registrarRotasDefis } = require('./defis-routes');
const { registrarRotasNFCe } = require('./nfce-routes');
const { registrarRotasImportacao } = require('./importacao-routes');
const { registrarRotasCFOPs } = require('./cfops-routes');
const { registrarRotasFiscalClassificacao } = require('./fiscal-classificacao-routes');
const { registrarRotasTiposOperacao } = require('./tipos-operacao-routes');
const { registrarRotasServicos } = require('./servicos-routes');
const { registrarRotasOptica } = require('./optica/optica-routes');
const { registrarRotasFeatures } = require('./features-routes');
const { registrarRotasCfopsEntradaMap } = require('./cfops-entrada-map-routes');
const { registrarRotasCobrancas } = require('./cobrancas-routes');
const { registrarRotasBoletoProvedores } = require('./boleto-provedores-routes');
const { registrarRotasBi } = require('./bi-routes');
const { registrarRotasPropostasParticipacoes } = require('./propostas-participacoes-routes');
const { registrarRotasPropostasMatch } = require('./propostas-match-routes');
const { registrarRotasGruposPalavras } = require('./grupos-palavras-routes');
const { registrarRotasBackup } = require('./backup-routes');
const { registrarRotasAnaliseIa } = require('./analise-ia-routes');
const { registrarRotasChatIa } = require('./chat-ia-routes');
const { registrarRotasCertificado } = require('./certificado-routes');
const { registrarRotasProxy } = require('./proxy-routes');
const { registrarRotasFornecedor } = require('./fornecedor-routes');
const { registrarRotasEstabelecimentos } = require('./estabelecimentos-routes');
const { registrarRotasTelegram } = require('./telegram-routes');
const { registrarRotasLances } = require('./lances-routes');
const { registrarRotasCredenciais } = require('./credenciais-routes');
const { registrarRotasPortaisIntegracao } = require('./portais-integracao-routes');
const { registrarRotasBNCSalas } = require('./bnc-salas-routes');
const { registrarRotasBNC } = require('./bnc-routes');
const { registrarRotasBLL } = require('./bll-routes');
const { registrarRotasBLLSalas } = require('./bll-salas-routes');
const { registrarRotasPcp } = require('./pcp-routes');
const { registrarRotasSC } = require('./sc-routes');
const { registrarRotasRobo } = require('./robo-routes');
const { registrarRotasTracking } = require('./tracking-routes');
const { registrarRotasProposta } = require('./proposta-routes');
const { registrarRotasSync } = require('./sync-routes');
const { registrarRotasPdf } = require('./pdf-routes');
const { registrarRotasAdmin } = require('./admin-routes');
const { registrarRotasChatLeitura } = require('./chat-leitura-routes');
const { registrarRotasChatMonitoramento } = require('./chat-monitoramento-routes');
const { registrarRotasChatMensagens } = require('./chat-mensagens-routes');
const { registrarRotasParticipacaoMonitoramento } = require('./participacao-monitoramento-routes');
const { registrarRotasWhatsApp } = require('./whatsapp-adapter');
const { registrarRotasWaCampanhas } = require('./wa-campaigns-routes');
const { registrarRotasPortalAdmin } = require('./portal-routes');
const { sendTelegram } = require('./telegram-client');

// NFSE-M06 onda 6.44 (2026-04-20): PORT + PNCP_API_BASE + PNCP_API_ITENS
// saem do deps bag e viram require direto de config.js. server.js nao
// precisa mais repassar essas constantes.
const { PORT, PNCP_API_BASE, PNCP_API_ITENS } = require('./config');

function registerProtectedRoutes(app, deps) {
  const {
    db, dbPath, pncpSync, salvarItens,
    getConfigValue, setConfigValue, getIAKeys,
  } = deps;

  // NFSE-M06 onda 5C / 6.30: wrappers finos sobre telegram-client.js. Eram
  // globais em server.js; aqui moram no closure do registry. Apenas as
  // chamadas abaixo (e o wiring do monitor-mensagens) os consomem.
  // enviarNotificacaoTelegram era consumido só pelo fluxo legado
  // extensao-chrome-routes (desativado 2026-04-22, substituído pelo
  // Electron Standalone); ficou disponível no telegram-client para
  // quem precisar no futuro.
  const enviarTelegram = (mensagem) => sendTelegram(db, mensagem);

  // ==================== CATÁLOGO PNCP ====================
  // onda 6.29: 5 rotas /api/licitacoes, /api/orgaos, detalhes, itens e sync-itens.
  registrarRotasLicitacoes(app, db, { pncpSync, salvarItens, PNCP_API_BASE, PNCP_API_ITENS });

  // ==================== SNIPER DE LANCES ====================
  registrarRotasSniper(app, db);

  // ==================== NFSE NACIONAL ====================
  registrarRotasNfse(app, db);

  // ==================== FINANCEIRO (Pessoas, Contas a Receber, Boletos, MercadoPago) ====================
  // FINANCEIRO precisa vir ANTES de cobrancas e contas-receber-routes
  // porque cria as tabelas pessoas e contas_a_receber, usadas por eles
  // em boot-time migrations (ALTER TABLE pessoas ADD cobrancaAtiva, etc.).
  registrarRotasFinanceiro(app, db);

  // ==================== BOLETO PROVEDORES (registry multi-banco) ====================
  registrarRotasBoletoProvedores(app, db);

  // ==================== COBRANÇAS + WHATSAPP ====================
  registrarRotasCobrancas(app, db);
  registrarRotasWhatsApp(app, db);
  registrarRotasWaCampanhas(app, db);

  // ==================== RECORRÊNCIAS NFSE ====================
  registrarRotasRecorrencia(app, db);

  // ==================== SUPRIMENTOS (Produtos, Estoque, Pedidos) ====================
  // contas-financeiras subido pra ANTES de pedidos — pedidos-routes cria
  // adquirentes_cartao com FK para contas_financeiras; ordem errada
  // só quebra no provision de tenant novo (FK recém-validada no ON).
  registrarRotasContasFinanceiras(app, db);
  // produto-lookup precisa vir ANTES de produtos-routes — produtos-routes
  // importa registrarLookup do módulo lookup. A ordem de require não exige,
  // mas a migração única (popular lookup a partir de produtos existentes)
  // depende de a tabela produto_lookup já estar criada por db-schema.js.
  registrarRotasProdutoLookup(app, db);
  registrarRotasProdutoMatch(app, db);
  registrarRotasFornecedores(app, db);
  registrarRotasProdutos(app, db);
  registrarRotasEstoque(app, db);
  registrarRotasDepositos(app, db);
  registrarRotasEtiquetas(app, db);
  registrarRotasLotes(app, db);
  registrarRotasSerial(app, db);
  registrarRotasReservas(app, db);
  registrarRotasInventario(app, db);
  registrarRotasCompras(app, db);
  registrarRotasPedidos(app, db);
  registrarRotasFaturas(app, db);
  registrarRotasNfeEmit(app, db);
  registrarRotasNfeEntrada(app, db);
  registrarRotasContasPagar(app, db);
  registrarRotasContasReceber(app, db);
  registrarRotasFinanceiroAvancado(app, db);
  registrarRotasCotacoes(app, db);
  registrarRotasContabilidade(app, db);
  registrarRotasRequisicoes(app, db);
  registrarRotasPrecos(app, db);
  registrarRotasFiscalOps(app, db);
  registrarRotasGovernanca(app, db);
  registrarRotasFluxoCaixa(app, db);
  registrarRotasFiscalSN(app, db);
  registrarRotasLivroCaixa(app, db);
  registrarRotasFiscalArquivamento(app, db);
  registrarRotasRetencoes(app, db);
  registrarRotasDefis(app, db);
  registrarRotasNFCe(app, db);
  registrarRotasImportacao(app, db);
  registrarRotasCFOPs(app, db);
  registrarRotasFiscalClassificacao(app, db);
  registrarRotasTiposOperacao(app, db);
  registrarRotasCfopsEntradaMap(app, db);

  // ==================== ÓTICA (módulo opcional) ====================
  registrarRotasOptica(app, db);

  // ==================== FEATURE FLAGS (sidebar usa) ====================
  registrarRotasFeatures(app, db);

  // ==================== ADMIN / RH / AUDITORIA ====================
  registrarRotasUsuarios(app, db);
  registrarRotasAuditoria(app, db);
  registrarRotasDevolucoes(app, db);
  require('./devolucao-compra').registrar(app, db); // Fase 1: migra schema espelho (rotas na Fase 3)
  registrarRotasCrm(app, db);
  registrarRotasGerencial(app, db);
  registrarRotasConciliacao(app, db);
  registrarRotasTesouraria(app, db);
  registrarRotasPlanejamento(app, db);
  registrarRotasContabilizacao(app, db);
  registrarRotasIbsCbs(app, db);
  registrarRotasComissoes(app, db);
  registrarRotasContratos(app, db);
  registrarRotasHabilitacao(app, db);
  registrarRotasComprasnetAnexos(app, db);
  registrarRotasPortalAdmin(app, db);
  registrarRotasServicos(app, db);
  registrarRotasOS(app, db);
  registrarRotasComm(app, db);
  registrarRotasMDFe(app, db);
  registrarRotasRH(app, db);
  registrarRotasPatrimonio(app, db);
  registrarRotasRoteirizacao(app, db);
  registrarRotasCTe(app, db);
  registrarRotasMarketplaces(app, db);
  require('./marketplaces-ml').registrarRotasTenant(app, db); // ML Fase 0: /connect + /status (per-tenant)
  registrarRotasTEF(app, db);

  // ==================== BI / IA / JORNAL / BACKUP / CERTIFICADO / PROXY / FORNECEDOR ====================
  registrarRotasBi(app, db);
  registrarRotasPropostasParticipacoes(app, db);
  registrarRotasPropostasMatch(app, db);
  registrarRotasGruposPalavras(app, db);
  registrarRotasBackup(app, db, { dbPath, PORT });
  registrarRotasAnaliseIa(app, db, { getConfigValue, setConfigValue, getIAKeys });
  registrarRotasChatIa(app, db, { getIAKeys });
  registrarRotasCertificado(app, db);
  registrarRotasProxy(app, db);
  registrarRotasFornecedor(app, db);
  // Multi-loja: cadastro de estabelecimentos (matriz + filiais). Fase 1.
  registrarRotasEstabelecimentos(app, db);

  // ==================== TELEGRAM / LANCES / CREDENCIAIS / ROBÔ / TRACKING / PROPOSTA ====================
  registrarRotasTelegram(app, db, { enviarTelegram });
  registrarRotasLances(app, db, { enviarTelegram });
  registrarRotasCredenciais(app, db);
  // Portais externos genéricos (BNC, BLL, etc.) — só usuário+senha em config.
  registrarRotasPortaisIntegracao(app, db);
  // BNC: cadastro de salas de disputa (processId, lotes) — alimenta scheduler.
  registrarRotasBNCSalas(app, db);
  // BNC: sessão + envio de proposta server-side (espelha o BLL).
  registrarRotasBNC(app, db);
  // BLL: sessão + envio de proposta (Fase 1/2). Lance (SignalR) vem na Fase 3.
  registrarRotasBLL(app, db);
  // BLL: cadastro de salas de disputa + auto-lance (Fase 3) — alimenta scheduler.
  registrarRotasBLLSalas(app, db);
  // Portal de Compras Públicas — sessão autenticada + listagem de Seus Pregões / Sessões Públicas.
  registrarRotasPcp(app, db);
  // Robô SC (cotacao.licitacao.sc.gov.br) — credenciais, sessão, sync (participações/disputa/chat).
  registrarRotasSC(app, db, { enviarTelegram });
  registrarRotasRobo(app, db);
  registrarRotasTracking(app, db);
  registrarRotasProposta(app, db);

  // ==================== SYNC / PDF / ADMIN / CHAT LEITURA ====================
  registrarRotasSync(app, db, { pncpSync });
  registrarRotasPdf(app, db);
  registrarRotasAdmin(app, db, { getConfigValue, setConfigValue });
  registrarRotasChatLeitura(app, db);

  // ==================== CREDENCIAIS GOV.BR + CHAT (leitura) ====================
  // Monitoramento server-side via Puppeteer foi removido em 2026-04-22:
  // captura de mensagens agora é 100% feita pelo Electron standalone
  // (envia via /api/sync/mensagens-global). Estas rotas apenas leem/editam
  // o estado já persistido e a config gov.br do tenant.
  registrarRotasGovBr(app, { getConfigValue, setConfigValue });
  registrarRotasChatMonitoramento(app, db);
  registrarRotasChatMensagens(app, db);
  registrarRotasParticipacaoMonitoramento(app, db, { enviarTelegram });
}

module.exports = { registerProtectedRoutes };
