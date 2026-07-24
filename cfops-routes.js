/**
 * cfops-routes.js — Cadastro de CFOPs e motor de sugestão automática.
 *
 * Tabelas:
 *   cfops          — catálogo de CFOPs com metadados
 *   cfops_regras   — regras que mapeiam contexto (UF, tipo cliente, origem produto)
 *                    em um CFOP específico
 *
 * Colunas adicionadas:
 *   pedido_itens.cfop — CFOP resolvido na inserção (editável pelo usuário)
 *   pessoas.contribuinteIcms — flag 0/1 (consumidor final vs contribuinte ICMS)
 *   produtos.tipoOrigemProduto — 'proprio' | 'revenda' (usado como insumo na regra)
 *
 * Endpoints:
 *   GET    /api/cfops
 *   GET    /api/cfops/:codigo
 *   POST   /api/cfops
 *   PUT    /api/cfops/:codigo
 *   DELETE /api/cfops/:codigo  (desativa)
 *
 *   GET    /api/cfops-regras
 *   POST   /api/cfops-regras
 *   PUT    /api/cfops-regras/:id
 *   DELETE /api/cfops-regras/:id
 *
 *   POST   /api/cfops/sugerir   — body: { clienteId, produtoId, entregaPorFabricante, ufEntrega }
 */

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* ok */ } }

const SEED_CFOPS = [
  // SAÍDAS — INTERNAS (5xxx)
  { codigo: '5101', descricao: 'Venda de produção do estabelecimento (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'venda_producao', exigeContribuinte: 0 },
  { codigo: '5102', descricao: 'Venda de mercadoria adquirida/recebida de terceiros (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'venda_revenda', exigeContribuinte: 0 },
  { codigo: '5103', descricao: 'Venda de produção do estabelecimento a não-contribuinte (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'venda_producao', exigeContribuinte: 0 },
  { codigo: '5104', descricao: 'Venda de mercadoria adquirida a não-contribuinte (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'venda_revenda', exigeContribuinte: 0 },
  { codigo: '5401', descricao: 'Venda de produção sujeita a Substituição Tributária (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'venda_producao_st', exigeContribuinte: 1 },
  { codigo: '5403', descricao: 'Venda de mercadoria adquirida sujeita a ST (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'venda_revenda_st', exigeContribuinte: 1 },
  { codigo: '5405', descricao: 'Venda de mercadoria adquirida sujeita a ST a consumidor final (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'venda_revenda_st', exigeContribuinte: 0 },
  { codigo: '5910', descricao: 'Remessa em bonificação, doação ou brinde (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'remessa', exigeContribuinte: 0 },
  { codigo: '5912', descricao: 'Remessa para entrega futura (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'remessa', exigeContribuinte: 0 },
  { codigo: '5933', descricao: 'Prestação de serviço tributada pelo ISSQN (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'servico', exigeContribuinte: 0 },
  { codigo: '5949', descricao: 'Outra saída de mercadoria ou prestação (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'outros', exigeContribuinte: 0 },

  // SAÍDAS — INTERESTADUAIS (6xxx)
  { codigo: '6101', descricao: 'Venda de produção do estabelecimento (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'venda_producao', exigeContribuinte: 0 },
  { codigo: '6102', descricao: 'Venda de mercadoria adquirida/recebida de terceiros (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'venda_revenda', exigeContribuinte: 0 },
  { codigo: '6103', descricao: 'Venda de produção a não-contribuinte (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'venda_producao', exigeContribuinte: 0 },
  { codigo: '6104', descricao: 'Venda de mercadoria adquirida a não-contribuinte (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'venda_revenda', exigeContribuinte: 0 },
  { codigo: '6107', descricao: 'Venda de produção a não-contribuinte (interestadual, consumidor final)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'venda_producao', exigeContribuinte: 0 },
  { codigo: '6108', descricao: 'Venda de mercadoria adquirida a não-contribuinte (interestadual, consumidor final)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'venda_revenda', exigeContribuinte: 0 },
  { codigo: '6401', descricao: 'Venda de produção sujeita a ST (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'venda_producao_st', exigeContribuinte: 1 },
  { codigo: '6403', descricao: 'Venda de mercadoria adquirida sujeita a ST (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'venda_revenda_st', exigeContribuinte: 1 },
  { codigo: '6910', descricao: 'Remessa em bonificação, doação ou brinde (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'remessa', exigeContribuinte: 0 },
  { codigo: '6912', descricao: 'Remessa para entrega futura (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'remessa', exigeContribuinte: 0 },
  { codigo: '6933', descricao: 'Prestação de serviço tributada pelo ISSQN (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'servico', exigeContribuinte: 0 },
  { codigo: '6949', descricao: 'Outra saída de mercadoria ou prestação (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'outros', exigeContribuinte: 0 },

  // SAÍDAS — EXTERIOR (7xxx)
  { codigo: '7101', descricao: 'Venda de produção do estabelecimento (exportação)', tipoOperacao: 'saida', destino: 'exterior', natureza: 'venda_producao', exigeContribuinte: 0 },
  { codigo: '7102', descricao: 'Venda de mercadoria adquirida (exportação)', tipoOperacao: 'saida', destino: 'exterior', natureza: 'venda_revenda', exigeContribuinte: 0 },

  // ENTRADAS — INTERNAS (1xxx)
  { codigo: '1101', descricao: 'Compra para industrialização (dentro do estado)', tipoOperacao: 'entrada', destino: 'interno', natureza: 'compra_industrializacao', exigeContribuinte: 0 },
  { codigo: '1102', descricao: 'Compra para comercialização (dentro do estado)', tipoOperacao: 'entrada', destino: 'interno', natureza: 'compra_revenda', exigeContribuinte: 0 },
  { codigo: '1403', descricao: 'Compra para comercialização em operação com ST (dentro do estado)', tipoOperacao: 'entrada', destino: 'interno', natureza: 'compra_revenda_st', exigeContribuinte: 0 },
  { codigo: '1556', descricao: 'Compra de material para uso ou consumo (dentro do estado)', tipoOperacao: 'entrada', destino: 'interno', natureza: 'compra_uso_consumo', exigeContribuinte: 0 },
  { codigo: '1949', descricao: 'Outra entrada de mercadoria ou aquisição (dentro do estado)', tipoOperacao: 'entrada', destino: 'interno', natureza: 'outros', exigeContribuinte: 0 },

  // ENTRADAS — INTERESTADUAIS (2xxx)
  { codigo: '2101', descricao: 'Compra para industrialização (interestadual)', tipoOperacao: 'entrada', destino: 'interestadual', natureza: 'compra_industrializacao', exigeContribuinte: 0 },
  { codigo: '2102', descricao: 'Compra para comercialização (interestadual)', tipoOperacao: 'entrada', destino: 'interestadual', natureza: 'compra_revenda', exigeContribuinte: 0 },
  { codigo: '2403', descricao: 'Compra para comercialização em operação com ST (interestadual)', tipoOperacao: 'entrada', destino: 'interestadual', natureza: 'compra_revenda_st', exigeContribuinte: 0 },
  { codigo: '2556', descricao: 'Compra de material para uso ou consumo (interestadual)', tipoOperacao: 'entrada', destino: 'interestadual', natureza: 'compra_uso_consumo', exigeContribuinte: 0 }
];

// Regras default (ordem de prioridade = ordem do array; index mais alto = mais específico)
// Avaliação: todas as regras compatíveis passam; pega a de MAIOR prioridade explícita (ou última por ordem).
const SEED_REGRAS = [
  // revenda + interno
  { descricao: 'Venda mercadoria revenda · dentro do estado (padrão)',
    destino: 'interno', tipoOrigemProduto: 'revenda', clienteEhContribuinte: null, entregaPorFabricante: 0,
    cfopCodigo: '5102', prioridade: 10 },
  // revenda + interestadual contribuinte
  { descricao: 'Venda mercadoria revenda · interestadual (contribuinte ICMS)',
    destino: 'interestadual', tipoOrigemProduto: 'revenda', clienteEhContribuinte: 1, entregaPorFabricante: 0,
    cfopCodigo: '6102', prioridade: 20 },
  // revenda + interestadual não-contribuinte
  { descricao: 'Venda mercadoria revenda · interestadual (consumidor final)',
    destino: 'interestadual', tipoOrigemProduto: 'revenda', clienteEhContribuinte: 0, entregaPorFabricante: 0,
    cfopCodigo: '6108', prioridade: 20 },
  // producao propria + interno
  { descricao: 'Venda produção própria · dentro do estado',
    destino: 'interno', tipoOrigemProduto: 'proprio', clienteEhContribuinte: null, entregaPorFabricante: 0,
    cfopCodigo: '5101', prioridade: 10 },
  // producao propria + interestadual contribuinte
  { descricao: 'Venda produção própria · interestadual (contribuinte)',
    destino: 'interestadual', tipoOrigemProduto: 'proprio', clienteEhContribuinte: 1, entregaPorFabricante: 0,
    cfopCodigo: '6101', prioridade: 20 },
  // producao propria + interestadual não-contribuinte
  { descricao: 'Venda produção própria · interestadual (consumidor final)',
    destino: 'interestadual', tipoOrigemProduto: 'proprio', clienteEhContribuinte: 0, entregaPorFabricante: 0,
    cfopCodigo: '6107', prioridade: 20 },
  // entrega por conta do fabricante (remessa)
  { descricao: 'Remessa por conta do fabricante · dentro do estado',
    destino: 'interno', tipoOrigemProduto: null, clienteEhContribuinte: null, entregaPorFabricante: 1,
    cfopCodigo: '5949', prioridade: 30 },
  { descricao: 'Remessa por conta do fabricante · interestadual',
    destino: 'interestadual', tipoOrigemProduto: null, clienteEhContribuinte: null, entregaPorFabricante: 1,
    cfopCodigo: '6949', prioridade: 30 }
];

// CFOPs de devolução e operações especiais — seed adicional.
// Inseridos via UPSERT idempotente pra não duplicar em bases que já tinham o catálogo básico.
const SEED_CFOPS_EXTRA = [
  // DEVOLUÇÃO DE VENDA — ENTRADA (cliente devolve, eu recebo de volta)
  { codigo: '1201', descricao: 'Devolução de venda de produção do estabelecimento (dentro do estado)', tipoOperacao: 'entrada', destino: 'interno', natureza: 'devolucao_venda', categoriaOperacao: 'devolucao_venda', finalidadeNFe: 4, cfopContrapartida: '5101' },
  { codigo: '1202', descricao: 'Devolução de venda de mercadoria adquirida (dentro do estado)', tipoOperacao: 'entrada', destino: 'interno', natureza: 'devolucao_venda', categoriaOperacao: 'devolucao_venda', finalidadeNFe: 4, cfopContrapartida: '5102' },
  { codigo: '1411', descricao: 'Devolução de venda de mercadoria sujeita a ST (dentro do estado)', tipoOperacao: 'entrada', destino: 'interno', natureza: 'devolucao_venda_st', categoriaOperacao: 'devolucao_venda', finalidadeNFe: 4, cfopContrapartida: '5403' },
  { codigo: '1910', descricao: 'Entrada de bonificação, doação ou brinde (dentro do estado)', tipoOperacao: 'entrada', destino: 'interno', natureza: 'bonificacao', categoriaOperacao: 'bonificacao', cfopContrapartida: '5910' },
  { codigo: '2201', descricao: 'Devolução de venda de produção do estabelecimento (interestadual)', tipoOperacao: 'entrada', destino: 'interestadual', natureza: 'devolucao_venda', categoriaOperacao: 'devolucao_venda', finalidadeNFe: 4, cfopContrapartida: '6101' },
  { codigo: '2202', descricao: 'Devolução de venda de mercadoria adquirida (interestadual)', tipoOperacao: 'entrada', destino: 'interestadual', natureza: 'devolucao_venda', categoriaOperacao: 'devolucao_venda', finalidadeNFe: 4, cfopContrapartida: '6102' },
  { codigo: '2411', descricao: 'Devolução de venda de mercadoria sujeita a ST (interestadual)', tipoOperacao: 'entrada', destino: 'interestadual', natureza: 'devolucao_venda_st', categoriaOperacao: 'devolucao_venda', finalidadeNFe: 4, cfopContrapartida: '6403' },
  { codigo: '2910', descricao: 'Entrada de bonificação, doação ou brinde (interestadual)', tipoOperacao: 'entrada', destino: 'interestadual', natureza: 'bonificacao', categoriaOperacao: 'bonificacao', cfopContrapartida: '6910' },
  { codigo: '3202', descricao: 'Devolução de venda de mercadoria adquirida (exterior)', tipoOperacao: 'entrada', destino: 'exterior', natureza: 'devolucao_venda', categoriaOperacao: 'devolucao_venda', finalidadeNFe: 4, cfopContrapartida: '7102' },

  // VENDA À ORDEM — SAÍDA (faturamento ao adquirente; entrega por conta e ordem)
  { codigo: '5120', descricao: 'Venda de mercadoria adquirida de terceiros entregue ao destinatário por conta e ordem do adquirente, em venda à ordem (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'venda_revenda', categoriaOperacao: 'venda', finalidadeNFe: 1, cfopContrapartida: '1202' },
  { codigo: '6120', descricao: 'Venda de mercadoria adquirida de terceiros entregue ao destinatário por conta e ordem do adquirente, em venda à ordem (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'venda_revenda', categoriaOperacao: 'venda', finalidadeNFe: 1, cfopContrapartida: '2202' },

  // DEVOLUÇÃO DE COMPRA — SAÍDA (eu devolvo ao fornecedor)
  { codigo: '5201', descricao: 'Devolução de compra para industrialização (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'devolucao_compra', categoriaOperacao: 'devolucao_compra', finalidadeNFe: 4, cfopContrapartida: '1101' },
  { codigo: '5202', descricao: 'Devolução de compra para comercialização (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'devolucao_compra', categoriaOperacao: 'devolucao_compra', finalidadeNFe: 4, cfopContrapartida: '1102' },
  { codigo: '5411', descricao: 'Devolução de compra para comercialização sujeita a ST (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'devolucao_compra_st', categoriaOperacao: 'devolucao_compra', finalidadeNFe: 4, cfopContrapartida: '1403' },
  { codigo: '5556', descricao: 'Devolução de compra de material para uso ou consumo (dentro do estado)', tipoOperacao: 'saida', destino: 'interno', natureza: 'devolucao_uso_consumo', categoriaOperacao: 'devolucao_compra', finalidadeNFe: 4, cfopContrapartida: '1556' },
  { codigo: '6201', descricao: 'Devolução de compra para industrialização (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'devolucao_compra', categoriaOperacao: 'devolucao_compra', finalidadeNFe: 4, cfopContrapartida: '2101' },
  { codigo: '6202', descricao: 'Devolução de compra para comercialização (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'devolucao_compra', categoriaOperacao: 'devolucao_compra', finalidadeNFe: 4, cfopContrapartida: '2102' },
  { codigo: '6411', descricao: 'Devolução de compra para comercialização sujeita a ST (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'devolucao_compra_st', categoriaOperacao: 'devolucao_compra', finalidadeNFe: 4, cfopContrapartida: '2403' },
  { codigo: '6556', descricao: 'Devolução de compra de material para uso ou consumo (interestadual)', tipoOperacao: 'saida', destino: 'interestadual', natureza: 'devolucao_uso_consumo', categoriaOperacao: 'devolucao_compra', finalidadeNFe: 4, cfopContrapartida: '2556' }
];

// Backfill de metadados (categoriaOperacao, cfopContrapartida, finalidadeNFe, flags) nos CFOPs do seed original.
// UPDATE idempotente: só grava se a coluna está null (respeita edições manuais).
const CFOPS_METADADOS_BACKFILL = {
  '5101': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '1201', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '102' },
  '5102': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '1202', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '102' },
  '5103': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '1201', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '102' },
  '5104': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '1202', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '102' },
  '5401': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '1411', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '500' },
  '5403': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '1411', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '500' },
  '5405': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '1411', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '500' },
  '5910': { categoriaOperacao: 'bonificacao', finalidadeNFe: 1, cfopContrapartida: '1910', movimentaEstoque: 1, geraFinanceiro: 0, csosnPadrao: '400' },
  '5912': { categoriaOperacao: 'remessa',     finalidadeNFe: 1, movimentaEstoque: 0, geraFinanceiro: 0 },
  '5933': { categoriaOperacao: 'servico',     finalidadeNFe: 1, movimentaEstoque: 0, geraFinanceiro: 1 },
  '5949': { categoriaOperacao: 'outros',      finalidadeNFe: 1, cfopContrapartida: '1949', movimentaEstoque: 0, geraFinanceiro: 0 },
  '6101': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '2201', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '102' },
  '6102': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '2202', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '102' },
  '6103': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '2201', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '102' },
  '6104': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '2202', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '102' },
  '6107': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '2201', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '102' },
  '6108': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '2202', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '102' },
  '6401': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '2411', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '500' },
  '6403': { categoriaOperacao: 'venda',       finalidadeNFe: 1, cfopContrapartida: '2411', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '500' },
  '6910': { categoriaOperacao: 'bonificacao', finalidadeNFe: 1, cfopContrapartida: '2910', movimentaEstoque: 1, geraFinanceiro: 0, csosnPadrao: '400' },
  '6912': { categoriaOperacao: 'remessa',     finalidadeNFe: 1, movimentaEstoque: 0, geraFinanceiro: 0 },
  '6933': { categoriaOperacao: 'servico',     finalidadeNFe: 1, movimentaEstoque: 0, geraFinanceiro: 1 },
  '6949': { categoriaOperacao: 'outros',      finalidadeNFe: 1, cfopContrapartida: '2949', movimentaEstoque: 0, geraFinanceiro: 0 },
  '7101': { categoriaOperacao: 'exportacao',  finalidadeNFe: 1, movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '102' },
  '7102': { categoriaOperacao: 'exportacao',  finalidadeNFe: 1, cfopContrapartida: '3202', movimentaEstoque: 1, geraFinanceiro: 1, csosnPadrao: '102' },
  '1101': { categoriaOperacao: 'compra',      finalidadeNFe: 1, cfopContrapartida: '5201', movimentaEstoque: 1, geraFinanceiro: 1, geraCreditoIcms: 1 },
  '1102': { categoriaOperacao: 'compra',      finalidadeNFe: 1, cfopContrapartida: '5202', movimentaEstoque: 1, geraFinanceiro: 1, geraCreditoIcms: 1 },
  '1403': { categoriaOperacao: 'compra',      finalidadeNFe: 1, cfopContrapartida: '5411', movimentaEstoque: 1, geraFinanceiro: 1, geraCreditoIcms: 0 },
  '1556': { categoriaOperacao: 'compra_uso_consumo', finalidadeNFe: 1, cfopContrapartida: '5556', movimentaEstoque: 0, geraFinanceiro: 1, geraCreditoIcms: 0 },
  '1949': { categoriaOperacao: 'outros',      finalidadeNFe: 1, cfopContrapartida: '5949', movimentaEstoque: 0, geraFinanceiro: 0 },
  '2101': { categoriaOperacao: 'compra',      finalidadeNFe: 1, cfopContrapartida: '6201', movimentaEstoque: 1, geraFinanceiro: 1, geraCreditoIcms: 1 },
  '2102': { categoriaOperacao: 'compra',      finalidadeNFe: 1, cfopContrapartida: '6202', movimentaEstoque: 1, geraFinanceiro: 1, geraCreditoIcms: 1 },
  '2403': { categoriaOperacao: 'compra',      finalidadeNFe: 1, cfopContrapartida: '6411', movimentaEstoque: 1, geraFinanceiro: 1, geraCreditoIcms: 0 },
  '2556': { categoriaOperacao: 'compra_uso_consumo', finalidadeNFe: 1, cfopContrapartida: '6556', movimentaEstoque: 0, geraFinanceiro: 1, geraCreditoIcms: 0 }
};

const SEED_REGRAS_EXTRA = [
  { descricao: 'Devolução de venda · dentro do estado',
    destino: 'interno', tipoOrigemProduto: null, clienteEhContribuinte: null, entregaPorFabricante: null,
    categoriaOperacao: 'devolucao_venda', cfopCodigo: '1202', prioridade: 40 },
  { descricao: 'Devolução de venda · interestadual',
    destino: 'interestadual', tipoOrigemProduto: null, clienteEhContribuinte: null, entregaPorFabricante: null,
    categoriaOperacao: 'devolucao_venda', cfopCodigo: '2202', prioridade: 40 },
  { descricao: 'Devolução de compra · dentro do estado (revenda)',
    destino: 'interno', tipoOrigemProduto: null, clienteEhContribuinte: null, entregaPorFabricante: null,
    categoriaOperacao: 'devolucao_compra', cfopCodigo: '5202', prioridade: 40 },
  { descricao: 'Devolução de compra · interestadual (revenda)',
    destino: 'interestadual', tipoOrigemProduto: null, clienteEhContribuinte: null, entregaPorFabricante: null,
    categoriaOperacao: 'devolucao_compra', cfopCodigo: '6202', prioridade: 40 }
];

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cfops (
      codigo TEXT PRIMARY KEY,
      descricao TEXT NOT NULL,
      tipoOperacao TEXT NOT NULL,
      destino TEXT NOT NULL,
      natureza TEXT,
      exigeContribuinte INTEGER DEFAULT 0,
      icmsAliquotaSugerida REAL,
      observacoes TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cfops_destino ON cfops(destino, tipoOperacao);

    CREATE TABLE IF NOT EXISTS cfops_regras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      descricao TEXT,
      destino TEXT,
      tipoOrigemProduto TEXT,
      clienteEhContribuinte INTEGER,
      entregaPorFabricante INTEGER,
      produtoId INTEGER,
      categoriaProduto TEXT,
      cfopCodigo TEXT NOT NULL,
      prioridade INTEGER DEFAULT 10,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cfopCodigo) REFERENCES cfops(codigo)
    );
    CREATE INDEX IF NOT EXISTS idx_regras_prio ON cfops_regras(prioridade DESC, id DESC);
  `);

  alterSafe(db, "ALTER TABLE pedido_itens ADD COLUMN cfop TEXT");
  alterSafe(db, "ALTER TABLE pessoas ADD COLUMN contribuinteIcms INTEGER DEFAULT 0");
  alterSafe(db, "ALTER TABLE produtos ADD COLUMN tipoOrigemProduto TEXT");

  // Parametrização fiscal do CFOP (2026-04-23): colunas novas para tornar o CFOP
  // um parametrizador completo, como em ERPs maduros.
  alterSafe(db, "ALTER TABLE cfops ADD COLUMN cfopContrapartida TEXT");
  alterSafe(db, "ALTER TABLE cfops ADD COLUMN movimentaEstoque INTEGER DEFAULT 1");
  alterSafe(db, "ALTER TABLE cfops ADD COLUMN geraFinanceiro INTEGER DEFAULT 1");
  alterSafe(db, "ALTER TABLE cfops ADD COLUMN geraCreditoIcms INTEGER DEFAULT 0");
  alterSafe(db, "ALTER TABLE cfops ADD COLUMN cstPadrao TEXT");
  alterSafe(db, "ALTER TABLE cfops ADD COLUMN csosnPadrao TEXT");
  alterSafe(db, "ALTER TABLE cfops ADD COLUMN aliquotaPisPadrao REAL");
  alterSafe(db, "ALTER TABLE cfops ADD COLUMN aliquotaCofinsPadrao REAL");
  alterSafe(db, "ALTER TABLE cfops ADD COLUMN finalidadeNFe INTEGER DEFAULT 1");
  alterSafe(db, "ALTER TABLE cfops ADD COLUMN categoriaOperacao TEXT");
  alterSafe(db, "ALTER TABLE cfops_regras ADD COLUMN categoriaOperacao TEXT");

  const count = db.prepare('SELECT COUNT(*) AS c FROM cfops').get().c;
  if (count === 0) {
    const ins = db.prepare(`INSERT INTO cfops
      (codigo, descricao, tipoOperacao, destino, natureza, exigeContribuinte)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction(() => {
      for (const c of SEED_CFOPS) ins.run(c.codigo, c.descricao, c.tipoOperacao, c.destino, c.natureza, c.exigeContribuinte);
    });
    tx();
    console.log(`[cfops] Seed de ${SEED_CFOPS.length} CFOPs inserida`);
  }

  // UPSERT dos CFOPs extras (devolução, bonificação, etc) — idempotente por PK.
  const insExtra = db.prepare(`INSERT OR IGNORE INTO cfops
    (codigo, descricao, tipoOperacao, destino, natureza, exigeContribuinte,
     categoriaOperacao, finalidadeNFe, cfopContrapartida)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`);
  const txExtra = db.transaction(() => {
    for (const c of SEED_CFOPS_EXTRA) {
      insExtra.run(c.codigo, c.descricao, c.tipoOperacao, c.destino, c.natureza,
        c.categoriaOperacao || null, c.finalidadeNFe || 1, c.cfopContrapartida || null);
    }
  });
  txExtra();

  // Backfill de metadados em CFOPs existentes.
  // Texto/null: usa COALESCE (só preenche se estiver null).
  // Flags (movimentaEstoque/geraFinanceiro/geraCreditoIcms): aplica direto o valor do
  // mapa — COALESCE não funcionaria porque a coluna já vem com DEFAULT preenchido.
  const updBackfill = db.prepare(`UPDATE cfops SET
    categoriaOperacao = COALESCE(categoriaOperacao, ?),
    finalidadeNFe = COALESCE(finalidadeNFe, ?),
    cfopContrapartida = COALESCE(cfopContrapartida, ?),
    movimentaEstoque = ?,
    geraFinanceiro = ?,
    geraCreditoIcms = ?,
    csosnPadrao = COALESCE(csosnPadrao, ?)
    WHERE codigo = ?`);
  const txBackfill = db.transaction(() => {
    for (const [codigo, m] of Object.entries(CFOPS_METADADOS_BACKFILL)) {
      updBackfill.run(
        m.categoriaOperacao || null,
        m.finalidadeNFe != null ? m.finalidadeNFe : null,
        m.cfopContrapartida || null,
        m.movimentaEstoque != null ? m.movimentaEstoque : 1,
        m.geraFinanceiro != null ? m.geraFinanceiro : 1,
        m.geraCreditoIcms != null ? m.geraCreditoIcms : 0,
        m.csosnPadrao || null,
        codigo
      );
    }
  });
  txBackfill();

  const countRegras = db.prepare('SELECT COUNT(*) AS c FROM cfops_regras').get().c;
  if (countRegras === 0) {
    const ins = db.prepare(`INSERT INTO cfops_regras
      (descricao, destino, tipoOrigemProduto, clienteEhContribuinte, entregaPorFabricante, cfopCodigo, prioridade)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction(() => {
      for (const r of SEED_REGRAS) ins.run(r.descricao, r.destino, r.tipoOrigemProduto, r.clienteEhContribuinte, r.entregaPorFabricante, r.cfopCodigo, r.prioridade);
    });
    tx();
    console.log(`[cfops] Seed de ${SEED_REGRAS.length} regras inserida`);
  }

  // Seed idempotente das regras extras — só insere se não existir descrição igual.
  const existeDesc = db.prepare('SELECT 1 FROM cfops_regras WHERE descricao = ?');
  const insRegraExtra = db.prepare(`INSERT INTO cfops_regras
    (descricao, destino, tipoOrigemProduto, clienteEhContribuinte, entregaPorFabricante,
     categoriaOperacao, cfopCodigo, prioridade)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const txRegraExtra = db.transaction(() => {
    for (const r of SEED_REGRAS_EXTRA) {
      if (!existeDesc.get(r.descricao)) {
        insRegraExtra.run(r.descricao, r.destino, r.tipoOrigemProduto, r.clienteEhContribuinte,
          r.entregaPorFabricante, r.categoriaOperacao, r.cfopCodigo, r.prioridade);
      }
    }
  });
  txRegraExtra();
}

function determinarDestino(ufEmitente, ufDestino) {
  if (!ufDestino) return 'interno';
  const e = (ufEmitente || '').toUpperCase();
  const d = (ufDestino || '').toUpperCase();
  if (d === 'EX' || d === 'EXTERIOR') return 'exterior';
  return e === d ? 'interno' : 'interestadual';
}

// Fallbacks heurísticos por categoria de operação, usados quando nenhuma regra casa.
const FALLBACK_POR_CATEGORIA = {
  venda:            { interno: '5102', interestadual: '6102', exterior: '7102' },
  devolucao_venda:  { interno: '1202', interestadual: '2202', exterior: '3202' },
  devolucao_compra: { interno: '5202', interestadual: '6202', exterior: null   },
  compra:           { interno: '1102', interestadual: '2102', exterior: null   },
  bonificacao:      { interno: '5910', interestadual: '6910', exterior: null   },
  transferencia:    { interno: '5152', interestadual: '6152', exterior: null   },
  remessa:          { interno: '5949', interestadual: '6949', exterior: null   },
  exportacao:       { interno: null,   interestadual: null,   exterior: '7102' }
};

function sugerirCFOP(db, params) {
  const { clienteId, produtoId, entregaPorFabricante, ufEntrega } = params;
  // Finalidade da operação — default 'venda'. Aceita: venda, devolucao_venda, devolucao_compra,
  // compra, bonificacao, transferencia, remessa, exportacao.
  const finalidade = params.finalidade || params.categoriaOperacao || 'venda';

  // Carrega contexto
  const emitente = db.prepare('SELECT uf FROM fornecedor WHERE id = 1').get();
  const cliente = clienteId ? db.prepare('SELECT id, uf, contribuinteIcms FROM pessoas WHERE id = ?').get(clienteId) : null;
  const produto = produtoId ? db.prepare('SELECT id, tipoOrigemProduto, cfopPadrao FROM produtos WHERE id = ?').get(produtoId) : null;

  const ufDest = ufEntrega || cliente?.uf || emitente?.uf;
  const destino = determinarDestino(emitente?.uf, ufDest);
  const clienteEhContribuinte = cliente ? (cliente.contribuinteIcms ? 1 : 0) : null;
  const entrega = entregaPorFabricante ? 1 : 0;
  const tipoOrigemProduto = produto?.tipoOrigemProduto || 'revenda';

  const contextoBase = {
    destino, clienteEhContribuinte, entregaPorFabricante: entrega, tipoOrigemProduto,
    ufEmitente: emitente?.uf, ufDestino: ufDest, finalidade
  };

  // Helper: carrega dados completos de um CFOP (inclui contrapartida).
  const carregarCfop = (codigo) => codigo ? db.prepare('SELECT * FROM cfops WHERE codigo = ?').get(codigo) : null;

  // DEVOLUÇÃO: resolve o CFOP de venda/compra primeiro e retorna sua contrapartida.
  // Isso garante coerência fiscal — devolução SEMPRE usa o CFOP reverso do CFOP original.
  if (finalidade === 'devolucao_venda' || finalidade === 'devolucao_compra') {
    const finOrigem = finalidade === 'devolucao_venda' ? 'venda' : 'compra';
    const sugOrigem = sugerirCFOP(db, { clienteId, produtoId, entregaPorFabricante, ufEntrega, finalidade: finOrigem });
    const cfopOrigem = carregarCfop(sugOrigem.cfop);
    const codContrap = cfopOrigem?.cfopContrapartida;
    if (codContrap) {
      const cfopDev = carregarCfop(codContrap);
      return {
        cfop: codContrap,
        cfopDescricao: cfopDev?.descricao || null,
        contexto: { ...contextoBase, cfopOriginal: sugOrigem.cfop },
        regra: { id: null, descricao: `Contrapartida fiscal de ${sugOrigem.cfop}`, prioridade: 100 }
      };
    }
    // Sem contrapartida cadastrada — cai no fallback por categoria.
  }

  // OVERRIDE: se o produto tem cfopPadrao cadastrado e ele casa com destino+tipoOperacao da
  // finalidade corrente, respeita (o usuário quis algo específico). Só para finalidade=venda
  // — em devolução não faz sentido usar o cfopPadrao de venda direto.
  if (finalidade === 'venda' && produto?.cfopPadrao) {
    const cfopProd = carregarCfop(produto.cfopPadrao);
    if (cfopProd?.ativo && cfopProd.destino === destino && cfopProd.tipoOperacao === 'saida') {
      return {
        cfop: cfopProd.codigo,
        cfopDescricao: cfopProd.descricao,
        contexto: contextoBase,
        regra: { id: null, descricao: `cfopPadrao cadastrado no produto #${produtoId}`, prioridade: 999 }
      };
    }
  }

  // Busca regras ativas, ordenadas por prioridade desc.
  const regras = db.prepare(`SELECT * FROM cfops_regras WHERE ativo = 1 ORDER BY prioridade DESC, id DESC`).all();

  const matches = (r) => {
    if (r.destino && r.destino !== destino) return false;
    // Regra com categoriaOperacao preenchida: exige match exato.
    // Regra sem categoriaOperacao (seed original pré-2026-04-23): só se aplica a venda,
    // senão regras genéricas vazam para compra/devolução e devolvem CFOP errado.
    if (r.categoriaOperacao) {
      if (r.categoriaOperacao !== finalidade) return false;
    } else if (finalidade !== 'venda') {
      return false;
    }
    if (r.tipoOrigemProduto && r.tipoOrigemProduto !== tipoOrigemProduto) return false;
    if (r.clienteEhContribuinte != null && clienteEhContribuinte != null && r.clienteEhContribuinte !== clienteEhContribuinte) return false;
    if (r.entregaPorFabricante != null && r.entregaPorFabricante !== entrega) return false;
    if (r.produtoId && produtoId && r.produtoId !== produtoId) return false;
    return true;
  };

  for (const r of regras) {
    if (matches(r)) {
      const cfop = carregarCfop(r.cfopCodigo);
      return {
        cfop: r.cfopCodigo,
        cfopDescricao: cfop?.descricao || null,
        contexto: contextoBase,
        regra: { id: r.id, descricao: r.descricao, prioridade: r.prioridade }
      };
    }
  }

  // Fallback heurístico por categoria + destino.
  const tabela = FALLBACK_POR_CATEGORIA[finalidade] || FALLBACK_POR_CATEGORIA.venda;
  let fallback = tabela[destino];
  // Refinamento para venda: contribuinte vs não-contribuinte.
  if (finalidade === 'venda' && destino === 'interestadual') {
    fallback = clienteEhContribuinte === 0 ? '6108' : '6102';
  }
  const cfopFb = carregarCfop(fallback);
  return {
    cfop: fallback,
    cfopDescricao: cfopFb?.descricao || null,
    contexto: contextoBase,
    regra: { id: null, descricao: `Fallback heurístico · ${finalidade} ${destino}`, prioridade: 0 }
  };
}

function registrarRotas(app, db) {
  migrar(db);

  // ==================== CFOP CRUD ====================
  app.get('/api/cfops', (req, res) => {
    try {
      const { tipoOperacao, destino, ativo, busca } = req.query;
      let sql = 'SELECT * FROM cfops WHERE 1=1';
      const p = [];
      if (tipoOperacao) { sql += ' AND tipoOperacao = ?'; p.push(tipoOperacao); }
      if (destino) { sql += ' AND destino = ?'; p.push(destino); }
      if (ativo !== undefined) { sql += ' AND ativo = ?'; p.push(Number(ativo)); }
      else { sql += ' AND ativo = 1'; }
      if (busca) { sql += ' AND (codigo LIKE ? OR descricao LIKE ?)'; const t = '%'+busca+'%'; p.push(t, t); }
      sql += ' ORDER BY codigo ASC';
      res.json({ success: true, cfops: db.prepare(sql).all(...p) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/cfops/:codigo', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM cfops WHERE codigo = ?').get(req.params.codigo);
      if (!c) return res.status(404).json({ success: false, error: 'CFOP não encontrado' });
      res.json({ success: true, cfop: c });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/cfops', (req, res) => {
    try {
      const b = req.body || {};
      if (!b.codigo || !b.descricao || !b.tipoOperacao || !b.destino) {
        return res.status(400).json({ success: false, error: 'codigo, descricao, tipoOperacao, destino obrigatórios' });
      }
      if (!['saida', 'entrada'].includes(b.tipoOperacao)) return res.status(400).json({ success: false, error: 'tipoOperacao inválido' });
      if (!['interno', 'interestadual', 'exterior'].includes(b.destino)) return res.status(400).json({ success: false, error: 'destino inválido' });
      db.prepare(`INSERT INTO cfops
        (codigo, descricao, tipoOperacao, destino, natureza, exigeContribuinte, icmsAliquotaSugerida, observacoes,
         cfopContrapartida, movimentaEstoque, geraFinanceiro, geraCreditoIcms,
         cstPadrao, csosnPadrao, aliquotaPisPadrao, aliquotaCofinsPadrao,
         finalidadeNFe, categoriaOperacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        b.codigo, b.descricao, b.tipoOperacao, b.destino,
        b.natureza || null, b.exigeContribuinte ? 1 : 0,
        b.icmsAliquotaSugerida != null ? Number(b.icmsAliquotaSugerida) : null,
        b.observacoes || null,
        b.cfopContrapartida || null,
        b.movimentaEstoque != null ? (b.movimentaEstoque ? 1 : 0) : 1,
        b.geraFinanceiro != null ? (b.geraFinanceiro ? 1 : 0) : 1,
        b.geraCreditoIcms != null ? (b.geraCreditoIcms ? 1 : 0) : 0,
        b.cstPadrao || null,
        b.csosnPadrao || null,
        b.aliquotaPisPadrao != null ? Number(b.aliquotaPisPadrao) : null,
        b.aliquotaCofinsPadrao != null ? Number(b.aliquotaCofinsPadrao) : null,
        b.finalidadeNFe != null ? Number(b.finalidadeNFe) : 1,
        b.categoriaOperacao || null
      );
      res.json({ success: true, cfop: db.prepare('SELECT * FROM cfops WHERE codigo = ?').get(b.codigo) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/cfops/:codigo', (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM cfops WHERE codigo = ?').get(req.params.codigo);
      if (!atual) return res.status(404).json({ success: false, error: 'CFOP não encontrado' });
      const b = req.body || {};
      db.prepare(`UPDATE cfops SET
        descricao = ?, tipoOperacao = ?, destino = ?, natureza = ?,
        exigeContribuinte = ?, icmsAliquotaSugerida = ?, observacoes = ?, ativo = ?,
        cfopContrapartida = ?, movimentaEstoque = ?, geraFinanceiro = ?, geraCreditoIcms = ?,
        cstPadrao = ?, csosnPadrao = ?, aliquotaPisPadrao = ?, aliquotaCofinsPadrao = ?,
        finalidadeNFe = ?, categoriaOperacao = ?,
        dataAtualizacao = CURRENT_TIMESTAMP WHERE codigo = ?`).run(
        b.descricao ?? atual.descricao,
        b.tipoOperacao ?? atual.tipoOperacao,
        b.destino ?? atual.destino,
        b.natureza ?? atual.natureza,
        b.exigeContribuinte != null ? (b.exigeContribuinte ? 1 : 0) : atual.exigeContribuinte,
        b.icmsAliquotaSugerida != null ? Number(b.icmsAliquotaSugerida) : atual.icmsAliquotaSugerida,
        b.observacoes ?? atual.observacoes,
        b.ativo != null ? (b.ativo ? 1 : 0) : atual.ativo,
        b.cfopContrapartida ?? atual.cfopContrapartida,
        b.movimentaEstoque != null ? (b.movimentaEstoque ? 1 : 0) : atual.movimentaEstoque,
        b.geraFinanceiro != null ? (b.geraFinanceiro ? 1 : 0) : atual.geraFinanceiro,
        b.geraCreditoIcms != null ? (b.geraCreditoIcms ? 1 : 0) : atual.geraCreditoIcms,
        b.cstPadrao ?? atual.cstPadrao,
        b.csosnPadrao ?? atual.csosnPadrao,
        b.aliquotaPisPadrao != null ? Number(b.aliquotaPisPadrao) : atual.aliquotaPisPadrao,
        b.aliquotaCofinsPadrao != null ? Number(b.aliquotaCofinsPadrao) : atual.aliquotaCofinsPadrao,
        b.finalidadeNFe != null ? Number(b.finalidadeNFe) : atual.finalidadeNFe,
        b.categoriaOperacao ?? atual.categoriaOperacao,
        req.params.codigo
      );
      res.json({ success: true, cfop: db.prepare('SELECT * FROM cfops WHERE codigo = ?').get(req.params.codigo) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/cfops/:codigo', (req, res) => {
    try {
      const r = db.prepare('UPDATE cfops SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE codigo = ? AND ativo = 1').run(req.params.codigo);
      if (!r.changes) return res.status(404).json({ success: false, error: 'CFOP não encontrado' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== REGRAS CRUD ====================
  app.get('/api/cfops-regras', (req, res) => {
    try {
      const rows = db.prepare(`SELECT r.*, c.descricao AS cfopDescricao
        FROM cfops_regras r LEFT JOIN cfops c ON c.codigo = r.cfopCodigo
        WHERE r.ativo = 1 ORDER BY r.prioridade DESC, r.id ASC`).all();
      res.json({ success: true, regras: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/cfops-regras', (req, res) => {
    try {
      const b = req.body || {};
      if (!b.cfopCodigo) return res.status(400).json({ success: false, error: 'cfopCodigo obrigatório' });
      const cfop = db.prepare('SELECT codigo FROM cfops WHERE codigo = ?').get(b.cfopCodigo);
      if (!cfop) return res.status(400).json({ success: false, error: 'CFOP informado não existe' });
      const r = db.prepare(`INSERT INTO cfops_regras
        (descricao, destino, tipoOrigemProduto, clienteEhContribuinte, entregaPorFabricante,
         produtoId, categoriaProduto, categoriaOperacao, cfopCodigo, prioridade)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        b.descricao || null, b.destino || null, b.tipoOrigemProduto || null,
        b.clienteEhContribuinte != null ? (b.clienteEhContribuinte ? 1 : 0) : null,
        b.entregaPorFabricante != null ? (b.entregaPorFabricante ? 1 : 0) : null,
        b.produtoId || null, b.categoriaProduto || null,
        b.categoriaOperacao || null,
        b.cfopCodigo, Number(b.prioridade) || 10
      );
      res.json({ success: true, regra: db.prepare('SELECT * FROM cfops_regras WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/cfops-regras/:id', (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM cfops_regras WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Regra não encontrada' });
      const b = req.body || {};
      db.prepare(`UPDATE cfops_regras SET
        descricao = ?, destino = ?, tipoOrigemProduto = ?, clienteEhContribuinte = ?,
        entregaPorFabricante = ?, produtoId = ?, categoriaProduto = ?, categoriaOperacao = ?,
        cfopCodigo = ?, prioridade = ?, ativo = ?
        WHERE id = ?`).run(
        b.descricao ?? atual.descricao,
        b.destino ?? atual.destino,
        b.tipoOrigemProduto ?? atual.tipoOrigemProduto,
        b.clienteEhContribuinte != null ? (b.clienteEhContribuinte ? 1 : 0) : atual.clienteEhContribuinte,
        b.entregaPorFabricante != null ? (b.entregaPorFabricante ? 1 : 0) : atual.entregaPorFabricante,
        b.produtoId ?? atual.produtoId,
        b.categoriaProduto ?? atual.categoriaProduto,
        b.categoriaOperacao ?? atual.categoriaOperacao,
        b.cfopCodigo ?? atual.cfopCodigo,
        b.prioridade != null ? Number(b.prioridade) : atual.prioridade,
        b.ativo != null ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id
      );
      res.json({ success: true, regra: db.prepare('SELECT * FROM cfops_regras WHERE id = ?').get(req.params.id) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/cfops-regras/:id', (req, res) => {
    try {
      const r = db.prepare('UPDATE cfops_regras SET ativo = 0 WHERE id = ? AND ativo = 1').run(req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Regra não encontrada' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== SUGESTÃO ====================
  app.post('/api/cfops/sugerir', (req, res) => {
    try {
      const r = sugerirCFOP(db, req.body || {});
      res.json({ success: true, ...r });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/cfops/sugerir', (req, res) => {
    try {
      const r = sugerirCFOP(db, {
        clienteId: req.query.clienteId ? Number(req.query.clienteId) : null,
        produtoId: req.query.produtoId ? Number(req.query.produtoId) : null,
        entregaPorFabricante: req.query.entregaPorFabricante === '1',
        ufEntrega: req.query.ufEntrega || null,
        finalidade: req.query.finalidade || null
      });
      res.json({ success: true, ...r });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ITEM DE PEDIDO ====================
  app.put('/api/pedidos/:pedidoId/itens/:itemId/cfop', (req, res) => {
    try {
      const cfop = (req.body?.cfop || '').trim();
      if (!cfop) return res.status(400).json({ success: false, error: 'cfop obrigatório' });
      const existe = db.prepare('SELECT codigo FROM cfops WHERE codigo = ?').get(cfop);
      if (!existe) return res.status(400).json({ success: false, error: 'CFOP não cadastrado' });
      const r = db.prepare('UPDATE pedido_itens SET cfop = ? WHERE id = ? AND pedidoId = ?')
        .run(cfop, req.params.itemId, req.params.pedidoId);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Item não encontrado neste pedido' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[cfops] Rotas registradas');
}

module.exports = { registrarRotasCFOPs: registrarRotas, sugerirCFOP };
