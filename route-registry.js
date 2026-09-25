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
 *   - agendarRecorrencias / agendarCobrancas /
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
const { registrarRotasSslCertificados } = require('./ssl-certificados-routes');
const { registrarRotasFornecedorIntegracoes } = require('./fornecedor-integracoes');
const { registrarRotasHabilitacao } = require('./habilitacao-routes');
const { registrarRotasComprasnetAnexos } = require('./comprasnet-anexos-routes');
const { registrarRotasResultadoItem } = require('./resultado-item-routes');
const { registrarRotasComprasnetMensagem } = require('./comprasnet-mensagem-routes');
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
const { registrarRotasPoliticasPrazo } = require('./politicas-prazo-routes');
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
const { registrarRotasNecessidadesCompra } = require('./necessidades-compra-routes');
const { registrarRotasPedidos } = require('./pedidos-routes');
const { registrarRotasFaturas } = require('./faturas-routes');
const { registrarRotasContasFinanceiras } = require('./contas-financeiras-routes');
const { registrarRotasNfeEmit } = require('./nfe-emit-routes');
const { registrarRotasNfAvulsa } = require('./nf-avulsa-routes');
const { registrarRotasFiscalRegras } = require('./fiscal-regras-routes');
const { registrarRotasFiscalDiagnostico } = require('./fiscal-diagnostico-routes');
const { registrarRotasFiscalApuracaoIcms } = require('./fiscal-apuracao-icms');
const { registrarRotasFiscalApuracaoPisCofins } = require('./fiscal-apuracao-piscofins');
const { registrarRotasFiscalApuracaoIpi } = require('./fiscal-apuracao-ipi');
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
const { registrarRotasRestaurante } = require('./restaurante/restaurante-routes');
const { registrarRotasFarmacia } = require('./farmacia/farmacia-routes');
const { registrarRotasPosto } = require('./posto/posto-routes');
const { registrarRotasLocacao } = require('./locacao/locacao-routes');
const { registrarRotasProducao } = require('./producao/producao-routes');
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
const { registrarRotasNotificacoes } = require('./notificacoes-routes');
const { registrarFeatureGates } = require('./feature-gate');

// NFSE-M06 onda 6.44 (2026-04-20): PORT + PNCP_API_BASE + PNCP_API_ITENS
// saem do deps bag e viram require direto de config.js. server.js nao
// precisa mais repassar essas constantes.
const { PORT, PNCP_API_BASE, PNCP_API_ITENS } = require('./config');

function registerProtectedRoutes(app, deps) {
  const {
    db, dbPath, pncpSync, salvarItens,
    getConfigValue, setConfigValue, getIAKeys,
  } = deps;

  /**
   * Isolamento de falha por módulo — LIGADO SÓ NO PROVISIONAMENTO.
   *
   * Cada `registrarRotasX` também executa as migrations do seu módulo (os
   * `db.exec`/`alterSafe` que vivem no escopo de registro). Até 2026-09-11 uma
   * exceção em qualquer um deles abortava a cadeia inteira: os módulos
   * seguintes nunca registravam e, portanto, nunca preparavam o schema. Num
   * tenant recém-provisionado isso deixava ~277 tabelas em vez de ~374, sem
   * `pedidos.vendedorId`, sem comissões, metas nem CRM — e `POST /api/pedidos`
   * respondia 500. Medido no relatório 14.
   *
   * No BOOT do servidor o comportamento continua o de sempre: sem
   * `isolarFalhasDeMigracao`, a exceção sobe e o processo morre. Isso é
   * desejado — subir pela metade, escondendo um módulo quebrado, é pior do que
   * não subir.
   *
   * No PROVISIONAMENTO (tenant-provision.js) o isolamento é ligado: um módulo
   * com problema não pode impedir os outros 123 de criar as tabelas deles. As
   * falhas não são engolidas — voltam em `falhasDeMigracao` para quem chamou
   * decidir, e são logadas com o nome do módulo.
   */
  const isolar = !!(deps && deps.isolarFalhasDeMigracao);
  const falhasDeMigracao = [];
  const R = (nome, fn) => {
    if (!isolar) return fn();
    try { return fn(); }
    catch (err) {
      falhasDeMigracao.push({ modulo: nome, erro: err.message });
      console.warn(`[route-registry] módulo "${nome}" falhou na migração: ${err.message}`);
      return undefined;
    }
  };

  // NFSE-M06 onda 5C / 6.30: wrappers finos sobre telegram-client.js. Eram
  // globais em server.js; aqui moram no closure do registry. Apenas as
  // chamadas abaixo (e o wiring do monitor-mensagens) os consomem.
  // enviarNotificacaoTelegram era consumido só pelo fluxo legado
  // extensao-chrome-routes (desativado 2026-04-22, substituído pelo
  // Electron Standalone); ficou disponível no telegram-client para
  // quem precisar no futuro.
  // As opções são repassadas para que o teste de credenciais possa usar
  // { ignorarCanal: true } (ver telegram-client.canalTelegramLigado).
  const enviarTelegram = (mensagem, opts) => sendTelegram(db, mensagem, opts);

  // Gate dos módulos pagos ANTES de qualquer rota: um app.use registrado
  // depois do handler não é consultado, e o gate viraria decoração.
  registrarFeatureGates(app, db);

  // ==================== CATÁLOGO PNCP ====================
  // onda 6.29: 5 rotas /api/licitacoes, /api/orgaos, detalhes, itens e sync-itens.
  R('Licitacoes', () => registrarRotasLicitacoes(app, db, { pncpSync, salvarItens, PNCP_API_BASE, PNCP_API_ITENS }));
  // ==================== NOTIFICAÇÕES (canais de alerta) ====================
  R('Notificacoes', () => registrarRotasNotificacoes(app, db));
  // ==================== SNIPER DE LANCES ====================
  R('Sniper', () => registrarRotasSniper(app, db));
  // ==================== NFSE NACIONAL ====================
  R('Nfse', () => registrarRotasNfse(app, db));
  // ==================== FINANCEIRO (Pessoas, Contas a Receber, Boletos, MercadoPago) ====================
  // FINANCEIRO precisa vir ANTES de cobrancas e contas-receber-routes
  // porque cria as tabelas pessoas e contas_a_receber, usadas por eles
  // em boot-time migrations (ALTER TABLE pessoas ADD cobrancaAtiva, etc.).
  R('Financeiro', () => registrarRotasFinanceiro(app, db));
  // ==================== BOLETO PROVEDORES (registry multi-banco) ====================
  R('BoletoProvedores', () => registrarRotasBoletoProvedores(app, db));
  // ==================== COBRANÇAS + WHATSAPP ====================
  R('Cobrancas', () => registrarRotasCobrancas(app, db));
  R('WhatsApp', () => registrarRotasWhatsApp(app, db));
  R('WaCampanhas', () => registrarRotasWaCampanhas(app, db));
  // ==================== RECORRÊNCIAS NFSE ====================
  R('Recorrencia', () => registrarRotasRecorrencia(app, db));
  // ==================== SUPRIMENTOS (Produtos, Estoque, Pedidos) ====================
  // contas-financeiras subido pra ANTES de pedidos — pedidos-routes cria
  // adquirentes_cartao com FK para contas_financeiras; ordem errada
  // só quebra no provision de tenant novo (FK recém-validada no ON).
  R('ContasFinanceiras', () => registrarRotasContasFinanceiras(app, db));
  // produto-lookup precisa vir ANTES de produtos-routes — produtos-routes
  // importa registrarLookup do módulo lookup. A ordem de require não exige,
  // mas a migração única (popular lookup a partir de produtos existentes)
  // depende de a tabela produto_lookup já estar criada por db-schema.js.
  R('ProdutoLookup', () => registrarRotasProdutoLookup(app, db));
  R('ProdutoMatch', () => registrarRotasProdutoMatch(app, db));
  R('Fornecedores', () => registrarRotasFornecedores(app, db));
  R('Produtos', () => registrarRotasProdutos(app, db));
  R('Estoque', () => registrarRotasEstoque(app, db));
  R('Depositos', () => registrarRotasDepositos(app, db));
  R('Etiquetas', () => registrarRotasEtiquetas(app, db));
  R('Lotes', () => registrarRotasLotes(app, db));
  R('Serial', () => registrarRotasSerial(app, db));
  R('Reservas', () => registrarRotasReservas(app, db));
  R('Inventario', () => registrarRotasInventario(app, db));
  R('Compras', () => registrarRotasCompras(app, db));
  R('Pedidos', () => registrarRotasPedidos(app, db));
  R('Faturas', () => registrarRotasFaturas(app, db));
  R('NfeEmit', () => registrarRotasNfeEmit(app, db));
  // Depois do NfeEmit: a NF avulsa chama o emitirNFe dele, e o migrar() daqui
  // precisa de `faturas` já criada por registrarRotasFaturas, acima.
  R('NfAvulsa', () => registrarRotasNfAvulsa(app, db));
  // Depois da NF avulsa: o migrar() dela é que garante a tabela fiscal_regras_trib.
  R('FiscalRegras', () => registrarRotasFiscalRegras(app, db));
  R('FiscalDiagnostico', () => registrarRotasFiscalDiagnostico(app, db));
  R('FiscalApuracaoIcms', () => registrarRotasFiscalApuracaoIcms(app, db));
  R('FiscalApuracaoPisCofins', () => registrarRotasFiscalApuracaoPisCofins(app, db));
  R('FiscalApuracaoIpi', () => registrarRotasFiscalApuracaoIpi(app, db));
  R('NfeEntrada', () => registrarRotasNfeEntrada(app, db));
  R('ContasPagar', () => registrarRotasContasPagar(app, db));
  R('ContasReceber', () => registrarRotasContasReceber(app, db));
  R('FinanceiroAvancado', () => registrarRotasFinanceiroAvancado(app, db));
  R('Cotacoes', () => registrarRotasCotacoes(app, db));
  // Depende das migrações de compras, pedidos e cotações já terem rodado —
  // as colunas de origem que ele grava nascem lá.
  R('NecessidadesCompra', () => registrarRotasNecessidadesCompra(app, db));
  R('Contabilidade', () => registrarRotasContabilidade(app, db));
  R('Requisicoes', () => registrarRotasRequisicoes(app, db));
  R('Precos', () => registrarRotasPrecos(app, db));
  R('PoliticasPrazo', () => registrarRotasPoliticasPrazo(app, db));
  R('FiscalOps', () => registrarRotasFiscalOps(app, db));
  R('Governanca', () => registrarRotasGovernanca(app, db));
  R('FluxoCaixa', () => registrarRotasFluxoCaixa(app, db));
  R('FiscalSN', () => registrarRotasFiscalSN(app, db));
  R('LivroCaixa', () => registrarRotasLivroCaixa(app, db));
  R('FiscalArquivamento', () => registrarRotasFiscalArquivamento(app, db));
  R('Retencoes', () => registrarRotasRetencoes(app, db));
  R('Defis', () => registrarRotasDefis(app, db));
  R('NFCe', () => registrarRotasNFCe(app, db));
  R('Importacao', () => registrarRotasImportacao(app, db));
  R('CFOPs', () => registrarRotasCFOPs(app, db));
  R('FiscalClassificacao', () => registrarRotasFiscalClassificacao(app, db));
  R('TiposOperacao', () => registrarRotasTiposOperacao(app, db));
  R('CfopsEntradaMap', () => registrarRotasCfopsEntradaMap(app, db));
  // ==================== ÓTICA (módulo opcional) ====================
  R('Optica', () => registrarRotasOptica(app, db));
  // ==================== RESTAURANTE (módulo opcional) ====================
  R('Restaurante', () => registrarRotasRestaurante(app, db));
  // ==================== FARMÁCIA (módulo opcional) ====================
  R('Farmacia', () => registrarRotasFarmacia(app, db));
  // ==================== LOCAÇÃO (módulo opcional) ====================
  R('Locacao', () => registrarRotasLocacao(app, db));
  // ==================== POSTO DE COMBUSTÍVEL (módulo opcional) ====================
  R('Posto', () => registrarRotasPosto(app, db));
  // ==================== PRÉ-MOLDADOS (módulo opcional) ====================
  R('Producao', () => registrarRotasProducao(app, db));
  // ==================== FEATURE FLAGS (sidebar usa) ====================
  R('Features', () => registrarRotasFeatures(app, db));
  // ==================== ADMIN / RH / AUDITORIA ====================
  R('Usuarios', () => registrarRotasUsuarios(app, db));
  // Perfis de acesso (RBAC por página) — o gate em si vive no auth-bootstrap,
  // aqui é o CRUD e o /meu-acesso que a sidebar consulta.
  require('./perfis-acesso').registrarRotasPerfis(app, db);
  R('Auditoria', () => registrarRotasAuditoria(app, db));
  R('Devolucoes', () => registrarRotasDevolucoes(app, db));
  require('./devolucao-compra').registrar(app, db); // devolução ao fornecedor (espelho da entrada)
  require('./devolucao-venda').registrar(app, db);  // devolução do cliente (espelho da saída)
  R('Crm', () => registrarRotasCrm(app, db));
  R('Gerencial', () => registrarRotasGerencial(app, db));
  R('Conciliacao', () => registrarRotasConciliacao(app, db));
  R('Tesouraria', () => registrarRotasTesouraria(app, db));
  R('Planejamento', () => registrarRotasPlanejamento(app, db));
  R('Contabilizacao', () => registrarRotasContabilizacao(app, db));
  R('IbsCbs', () => registrarRotasIbsCbs(app, db));
  R('Comissoes', () => registrarRotasComissoes(app, db));
  R('Contratos', () => registrarRotasContratos(app, db));
  R('SslCertificados', () => registrarRotasSslCertificados(app, db));
  R('FornecedorIntegracoes', () => registrarRotasFornecedorIntegracoes(app, db));
  R('Habilitacao', () => registrarRotasHabilitacao(app, db));
  R('ComprasnetAnexos', () => registrarRotasComprasnetAnexos(app, db));
  R('ResultadoItem', () => registrarRotasResultadoItem(app, db));
  R('ComprasnetMensagem', () => registrarRotasComprasnetMensagem(app, db));
  R('PortalAdmin', () => registrarRotasPortalAdmin(app, db));
  R('Servicos', () => registrarRotasServicos(app, db));
  R('OS', () => registrarRotasOS(app, db));
  R('Comm', () => registrarRotasComm(app, db));
  R('MDFe', () => registrarRotasMDFe(app, db));
  R('RH', () => registrarRotasRH(app, db));
  R('Patrimonio', () => registrarRotasPatrimonio(app, db));
  R('Roteirizacao', () => registrarRotasRoteirizacao(app, db));
  R('CTe', () => registrarRotasCTe(app, db));
  R('Marketplaces', () => registrarRotasMarketplaces(app, db));
  require('./marketplaces-ml').registrarRotasTenant(app, db); // ML Fase 0: /connect + /status (per-tenant)
  require('./loja-routes').registrarRotasLojaAdmin(app, db);      // Vitrine: painel do lojista (a parte pública é pré-auth)
  require('./conversas-routes').registrarRotasConversas(app, db); // Central de conversas: inbox + base da IA
  require('./push-routes').registrarRotasPush(app, db);           // Pop-up de mensagem nova (Web Push)
  require('./agenda-routes').registrarRotasAgenda(app, db);       // Agendamento de reuniao pelo proprio lead
  require('./roteiros-routes').registrarRotasRoteiros(app, db);   // Roteiros de venda: visita, pontuacao e resumo
  R('TEF', () => registrarRotasTEF(app, db));
  // ==================== BI / IA / JORNAL / BACKUP / CERTIFICADO / PROXY / FORNECEDOR ====================
  R('Bi', () => registrarRotasBi(app, db));
  R('PropostasParticipacoes', () => registrarRotasPropostasParticipacoes(app, db));
  R('PropostasMatch', () => registrarRotasPropostasMatch(app, db));
  R('GruposPalavras', () => registrarRotasGruposPalavras(app, db));
  R('Backup', () => registrarRotasBackup(app, db, { dbPath, PORT }));
  R('AnaliseIa', () => registrarRotasAnaliseIa(app, db, { getConfigValue, setConfigValue, getIAKeys }));
  R('ChatIa', () => registrarRotasChatIa(app, db, { getIAKeys }));
  R('Certificado', () => registrarRotasCertificado(app, db));
  R('Proxy', () => registrarRotasProxy(app, db));
  R('Fornecedor', () => registrarRotasFornecedor(app, db));
  // Multi-loja: cadastro de estabelecimentos (matriz + filiais). Fase 1.
  R('Estabelecimentos', () => registrarRotasEstabelecimentos(app, db));
  // ==================== TELEGRAM / LANCES / CREDENCIAIS / ROBÔ / TRACKING / PROPOSTA ====================
  R('Telegram', () => registrarRotasTelegram(app, db, { enviarTelegram }));
  R('Lances', () => registrarRotasLances(app, db, { enviarTelegram }));
  R('Credenciais', () => registrarRotasCredenciais(app, db));
  // Portais externos genéricos (BNC, BLL, etc.) — só usuário+senha em config.
  R('PortaisIntegracao', () => registrarRotasPortaisIntegracao(app, db));
  // BNC: cadastro de salas de disputa (processId, lotes) — alimenta scheduler.
  R('BNCSalas', () => registrarRotasBNCSalas(app, db));
  // BNC: sessão + envio de proposta server-side (espelha o BLL).
  R('BNC', () => registrarRotasBNC(app, db));
  // BLL: sessão + envio de proposta (Fase 1/2). Lance (SignalR) vem na Fase 3.
  R('BLL', () => registrarRotasBLL(app, db));
  // BLL: cadastro de salas de disputa + auto-lance (Fase 3) — alimenta scheduler.
  R('BLLSalas', () => registrarRotasBLLSalas(app, db));
  // Config individual do monitor de chat por portal (palavras-chave + Telegram).
  require('./chat-monitor-routes').registrarRotasChatMonitor(app, db);
  // Portal de Compras Públicas — sessão autenticada + listagem de Seus Pregões / Sessões Públicas.
  R('Pcp', () => registrarRotasPcp(app, db));
  // Robô SC (cotacao.licitacao.sc.gov.br) — credenciais, sessão, sync (participações/disputa/chat).
  R('SC', () => registrarRotasSC(app, db, { enviarTelegram }));
  R('Robo', () => registrarRotasRobo(app, db));
  R('Tracking', () => registrarRotasTracking(app, db));
  R('Proposta', () => registrarRotasProposta(app, db));
  // ==================== SYNC / PDF / ADMIN / CHAT LEITURA ====================
  R('Sync', () => registrarRotasSync(app, db, { pncpSync }));
  R('Pdf', () => registrarRotasPdf(app, db));
  R('Admin', () => registrarRotasAdmin(app, db, { getConfigValue, setConfigValue }));
  R('ChatLeitura', () => registrarRotasChatLeitura(app, db));
  // ==================== CREDENCIAIS GOV.BR + CHAT (leitura) ====================
  // Monitoramento server-side via Puppeteer foi removido em 2026-04-22:
  // captura de mensagens agora é 100% feita pelo Electron standalone
  // (envia via /api/sync/mensagens-global). Estas rotas apenas leem/editam
  // o estado já persistido e a config gov.br do tenant.
  R('GovBr', () => registrarRotasGovBr(app, { getConfigValue, setConfigValue }));
  R('ChatMonitoramento', () => registrarRotasChatMonitoramento(app, db));
  R('ChatMensagens', () => registrarRotasChatMensagens(app, db));
  R('ParticipacaoMonitoramento', () => registrarRotasParticipacaoMonitoramento(app, db, { enviarTelegram }));

  // Devolve o que falhou, para o provisionamento decidir o que fazer.
  return { falhasDeMigracao };
}

module.exports = { registerProtectedRoutes };
