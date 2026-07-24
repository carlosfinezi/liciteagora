/**
 * boleto-provedores/index.js — Registry de provedores de emissão de boleto.
 *
 * Cada arquivo em /boleto-provedores/*.js (exceto index.js) exporta:
 *   {
 *     nome: 'sicredi',
 *     label: 'Sicredi',
 *     camposConfig: [...]          — schema pro UI renderizar formulário
 *     requerCertificado: boolean   — se o provedor precisa de A1 .pfx
 *     async autenticar(cfg)        — obtém/refresh de token
 *     async criarBoleto(db, cfg, payload)
 *     async consultarBoleto(db, cfg, nossoNumero)
 *     async baixarBoleto(db, cfg, nossoNumero, motivo)
 *     webhookPath: '/webhook/boleto/sicredi'
 *     async processarWebhook(req, db, cfg)
 *     validarConfig(cfg)           — checa completude antes de salvar
 *   }
 *
 * Para adicionar um banco novo: basta criar o arquivo + adicionar 1 linha aqui.
 */

const manual = require('./manual');
const mercadopago = require('./mercadopago');
const sicredi = require('./sicredi');
const asaas = require('./asaas');

const PROVEDORES = {
  manual,
  mercadopago,
  sicredi,
  asaas,
};

function listar() {
  return Object.values(PROVEDORES).map(p => ({
    nome: p.nome,
    label: p.label,
    requerCertificado: !!p.requerCertificado,
    camposConfig: p.camposConfig || [],
    webhookPath: p.webhookPath || null,
  }));
}

function get(nome) {
  return PROVEDORES[nome] || null;
}

module.exports = { PROVEDORES, listar, get };
