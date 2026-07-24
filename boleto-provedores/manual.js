/**
 * boleto-provedores/manual.js — "Provedor" manual (sem registro bancário).
 *
 * Gera apenas registro local na tabela `boletos` com linha digitável e código de
 * barras montados pelos dados da conta financeira. Usado quando o cliente paga
 * por duplicata/depósito/PIX QR sem registro formal no banco.
 *
 * Não tem API, não tem webhook, não tem baixa automática. Conciliação é manual.
 */

module.exports = {
  nome: 'manual',
  label: 'Manual (sem registro)',
  requerCertificado: false,
  webhookPath: null,

  camposConfig: [
    { name: 'agencia', label: 'Agência', placeholder: '0000', required: false },
    { name: 'conta', label: 'Conta', placeholder: '00000-0', required: false },
    { name: 'observacao', label: 'Observação fixa', type: 'text', required: false },
  ],

  validarConfig(cfg) {
    return { ok: true };
  },

  async autenticar() {
    return { ok: true };
  },

  async criarBoleto(db, cfg, payload) {
    // Não há chamada externa — devolve dados mínimos pra gravar em `boletos`.
    // nossoNumero é gerenciado pelo orquestrador (usa proximoNossoNumero da config).
    const nossoNumero = payload.nossoNumero || String(Date.now()).slice(-10);
    return {
      nossoNumero,
      linhaDigitavel: '',           // vazio — linha digitável exige cálculo bancário real
      codigoBarras: '',
      urlBoleto: null,
      pdfBase64: null,
      statusProvedor: 'manual_sem_registro',
    };
  },

  async consultarBoleto(db, cfg, nossoNumero) {
    return { status: 'manual', mensagem: 'Emissão manual não possui consulta automática' };
  },

  async baixarBoleto(db, cfg, nossoNumero, motivo) {
    return { status: 'manual', mensagem: 'Emissão manual — baixa somente via edição da CR' };
  },

  async processarWebhook() {
    return null;
  },
};
