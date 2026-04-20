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
 * Wiring especial do robô monitor-mensagens (final da função):
 *   createMonitorMensagens → {MonitorMensagensComprasnet, MonitorChat}
 *   → passados para GovBr / MonitorMensagens / ExtensaoChrome.
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
const { registrarRotasOS } = require('./os-routes');
const { registrarRotasComm } = require('./comm-routes');
const { registrarRotasMDFe } = require('./mdfe-routes');
const { registrarRotasRH } = require('./rh-routes');
const { registrarRotasPatrimonio } = require('./patrimonio-routes');
const { registrarRotasRoteirizacao } = require('./roteirizacao-routes');
const { registrarRotasCTe } = require('./cte-routes');
const { registrarRotasMarketplaces } = require('./marketplaces-routes');
const { registrarRotasTEF } = require('./tef-routes');
const { registrarRotasMonitorV2, getMonitor } = require('./monitor-v2-routes');
const { registrarRotasLicitacoes } = require('./licitacoes-routes');
const { createMonitorMensagens } = require('./monitor-mensagens-core');
const { registrarRotasGovBr } = require('./govbr-routes');
const { registrarRotasMonitorMensagens } = require('./monitor-mensagens-routes');
const { registrarRotasSniper } = require('./sniper-lance-routes');
const { registrarRotasNfse } = require('./nfse-routes');
const { registrarRotasFinanceiro } = require('./financeiro-routes');
const { registrarRotasRecorrencia } = require('./recorrencia-routes');
const { registrarRotasProdutos } = require('./produtos-routes');
const { registrarRotasEstoque } = require('./estoque-routes');
const { registrarRotasLotes } = require('./lotes-routes');
const { registrarRotasSerial } = require('./serial-routes');
const { registrarRotasReservas } = require('./reservas-routes');
const { registrarRotasInventario } = require('./inventario-routes');
const { registrarRotasPedidosCompra } = require('./pedidos-compra-routes');
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
const { registrarRotasCobrancas } = require('./cobrancas-routes');
const { registrarRotasBi } = require('./bi-routes');
const { registrarRotasPropostasParticipacoes } = require('./propostas-participacoes-routes');
const { registrarRotasGruposPalavras } = require('./grupos-palavras-routes');
const { registrarRotasBackup } = require('./backup-routes');
const { registrarRotasAnaliseIa } = require('./analise-ia-routes');
const { registrarRotasJornal } = require('./jornal-routes');
const { registrarRotasCertificado } = require('./certificado-routes');
const { registrarRotasProxy } = require('./proxy-routes');
const { registrarRotasFornecedor } = require('./fornecedor-routes');
const { registrarRotasTelegram } = require('./telegram-routes');
const { registrarRotasLances } = require('./lances-routes');
const { registrarRotasCredenciais } = require('./credenciais-routes');
const { registrarRotasRobo } = require('./robo-routes');
const { registrarRotasTracking } = require('./tracking-routes');
const { registrarRotasProposta } = require('./proposta-routes');
const { registrarRotasSync } = require('./sync-routes');
const { registrarRotasPdf } = require('./pdf-routes');
const { registrarRotasAdmin } = require('./admin-routes');
const { registrarRotasChatLeitura } = require('./chat-leitura-routes');
const { registrarRotasExtensoes } = require('./extensoes-routes');
const { registrarRotasExtensaoChrome } = require('./extensao-chrome-routes');
const { registrarRotasChatMonitoramento } = require('./chat-monitoramento-routes');
const { registrarRotasChatMensagens } = require('./chat-mensagens-routes');
const { registrarRotasParticipacaoMonitoramento } = require('./participacao-monitoramento-routes');
const { registrarRotasWhatsApp } = require('./whatsapp-adapter');
const { registrarRotasPortalAdmin } = require('./portal-routes');
const { sendTelegram, sendNotificacao } = require('./telegram-client');

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
  const enviarTelegram = (mensagem) => sendTelegram(db, mensagem);
  const enviarNotificacaoTelegram = (dados) => sendNotificacao(db, dados);

  // ==================== CATÁLOGO PNCP ====================
  // onda 6.29: 5 rotas /api/licitacoes, /api/orgaos, detalhes, itens e sync-itens.
  registrarRotasLicitacoes(app, db, { pncpSync, salvarItens, PNCP_API_BASE, PNCP_API_ITENS });

  // ==================== MONITOR V2 (API direta Comprasnet) ====================
  registrarRotasMonitorV2(app, db, {
    enviarTelegram,
    getConfigValue,
    intervaloMinutos: 3,
  });

  // ==================== SNIPER DE LANCES ====================
  // getMonitor vem do MonitorV2 (mesmo módulo monitor-v2-routes).
  registrarRotasSniper(app, getMonitor, db);

  // ==================== NFSE NACIONAL ====================
  registrarRotasNfse(app, db);

  // ==================== COBRANÇAS + WHATSAPP ====================
  registrarRotasCobrancas(app, db);
  registrarRotasWhatsApp(app, db);

  // ==================== FINANCEIRO (Pessoas, Contas a Receber, Boletos, MercadoPago) ====================
  registrarRotasFinanceiro(app, db);

  // ==================== RECORRÊNCIAS NFSE ====================
  registrarRotasRecorrencia(app, db);

  // ==================== SUPRIMENTOS (Produtos, Estoque, Pedidos) ====================
  registrarRotasProdutos(app, db);
  registrarRotasEstoque(app, db);
  registrarRotasLotes(app, db);
  registrarRotasSerial(app, db);
  registrarRotasReservas(app, db);
  registrarRotasInventario(app, db);
  registrarRotasPedidosCompra(app, db);
  registrarRotasPedidos(app, db);
  registrarRotasContasFinanceiras(app, db);
  registrarRotasFaturas(app, db);
  registrarRotasNfeEmit(app, db);
  registrarRotasNfeEntrada(app, db);
  registrarRotasContasPagar(app, db);
  registrarRotasContasReceber(app, db);
  registrarRotasFluxoCaixa(app, db);
  registrarRotasFiscalSN(app, db);
  registrarRotasLivroCaixa(app, db);
  registrarRotasFiscalArquivamento(app, db);
  registrarRotasRetencoes(app, db);
  registrarRotasDefis(app, db);
  registrarRotasNFCe(app, db);
  registrarRotasImportacao(app, db);
  registrarRotasCFOPs(app, db);

  // ==================== ADMIN / RH / AUDITORIA ====================
  registrarRotasUsuarios(app, db);
  registrarRotasAuditoria(app, db);
  registrarRotasDevolucoes(app, db);
  registrarRotasCrm(app, db);
  registrarRotasGerencial(app, db);
  registrarRotasConciliacao(app, db);
  registrarRotasComissoes(app, db);
  registrarRotasContratos(app, db);
  registrarRotasPortalAdmin(app, db);
  registrarRotasOS(app, db);
  registrarRotasComm(app, db);
  registrarRotasMDFe(app, db);
  registrarRotasRH(app, db);
  registrarRotasPatrimonio(app, db);
  registrarRotasRoteirizacao(app, db);
  registrarRotasCTe(app, db);
  registrarRotasMarketplaces(app, db);
  registrarRotasTEF(app, db);

  // ==================== BI / IA / JORNAL / BACKUP / CERTIFICADO / PROXY / FORNECEDOR ====================
  registrarRotasBi(app, db);
  registrarRotasPropostasParticipacoes(app, db);
  registrarRotasGruposPalavras(app, db);
  registrarRotasBackup(app, db, { dbPath, PORT });
  registrarRotasAnaliseIa(app, db, { getConfigValue, setConfigValue, getIAKeys });
  registrarRotasJornal(app, db);
  registrarRotasCertificado(app, db);
  registrarRotasProxy(app, db);
  registrarRotasFornecedor(app, db);

  // ==================== TELEGRAM / LANCES / CREDENCIAIS / ROBÔ / TRACKING / PROPOSTA ====================
  registrarRotasTelegram(app, db, { enviarTelegram });
  registrarRotasLances(app, db, { enviarTelegram });
  registrarRotasCredenciais(app, db);
  registrarRotasRobo(app, db);
  registrarRotasTracking(app, db);
  registrarRotasProposta(app, db);

  // ==================== SYNC / PDF / ADMIN / CHAT LEITURA / EXTENSÕES ====================
  registrarRotasSync(app, db, { pncpSync });
  registrarRotasPdf(app, db);
  registrarRotasAdmin(app, db, { getConfigValue, setConfigValue });
  registrarRotasChatLeitura(app, db);
  registrarRotasExtensoes(app, { getConfigValue });

  // ==================== ROBÔ DE MONITORAMENTO DE MENSAGENS + CREDENCIAIS GOV.BR ====================
  // NFSE-M06 onda 6.28: wiring explícito, ordem importa.
  //   core → govbr (guarda MonitorMensagensComprasnet) → monitor-mensagens
  //     (guarda MonitorChat) → extensao-chrome (consome govbrApi.getMonitor).
  const { MonitorMensagensComprasnet, MonitorChat } = createMonitorMensagens({
    db, getConfigValue, enviarTelegram,
  });
  const govbrApi = registrarRotasGovBr(app, db, {
    getConfigValue, setConfigValue, MonitorMensagensComprasnet,
  });
  registrarRotasMonitorMensagens(app, db, { MonitorChat });
  registrarRotasExtensaoChrome(app, db, {
    getConfigValue, enviarNotificacaoTelegram, getMonitor: govbrApi.getMonitor,
  });
  registrarRotasChatMonitoramento(app, db);
  registrarRotasChatMensagens(app, db);
  registrarRotasParticipacaoMonitoramento(app, db, { enviarTelegram });
}

module.exports = { registerProtectedRoutes };
