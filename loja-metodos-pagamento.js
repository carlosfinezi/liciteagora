/**
 * loja-metodos-pagamento.js — o que a loja aceita receber, e por onde.
 *
 * Até 30/09/2026 a resposta a essa pergunta estava partida em dois lugares que
 * não se conheciam:
 *
 *   - `loja_config.pagamentoModo`, com quatro valores ('nenhum', 'pix',
 *     'boleto', 'pix-ou-boleto'), que decidia se a loja COBRA ONLINE;
 *   - `PAGAMENTOS_CHECKOUT`, três opções fixas no código do `loja-routes.js`
 *     (pix/dinheiro/cartão), que era o que o cliente DECLARAVA que ia pagar.
 *
 * As duas se atropelavam: com `pagamentoModo = 'pix'` o checkout escondia
 * dinheiro e cartão, porque não havia como dizer "cobro Pix no site E aceito
 * dinheiro na entrega". Era uma limitação da modelagem, não uma regra de
 * negócio, e é ela que esta tabela desfaz.
 *
 * A separação que faltava é entre MODALIDADE e MEIO FISCAL:
 *
 *   - a MODALIDADE diz quem recebe o dinheiro — 'online' passa pelo provedor
 *     de cobrança e nasce uma conta a receber emitida; 'manual' é combinado
 *     entre lojista e cliente, e o ERP só registra;
 *   - o MEIO FISCAL é o tPag da nota, e NÃO distingue as duas. Pix é 17 nos
 *     dois casos, e é por isso que `pix_online` e `pix_manual` precisam ser
 *     métodos diferentes com o mesmo código: a nota sai igual, o dinheiro
 *     entra por caminhos opostos.
 *
 * O que o lojista escolhe é quais métodos estão ativos e em qual atendimento.
 * O vocabulário (quais métodos existem) é do sistema, não dele: uma loja não
 * inventa um meio de pagamento que a SEFAZ não conhece.
 */

const MEIOS_ONLINE = { pix_online: 'criarPix', boleto_online: 'criarBoleto' };

/**
 * Os métodos que o sistema conhece. Não é configuração — é o vocabulário.
 *
 * `meioFiscal` é o tPag da NF-e/NFC-e, e sai de `meios-pagamento.js`: 01
 * dinheiro, 03 crédito, 04 débito, 15 boleto, 17 Pix. Nenhum foi inventado
 * aqui, e o do boleto em particular é o que o ERP já grava em
 * `contas_a_receber.formaPagamento` desde sempre.
 */
const CATALOGO = {
  pix_online:         { modalidade: 'online', meioFiscal: '17', provedor: 'cobranca', ordem: 10,
                        rotulo: 'PIX online', descricao: 'O cliente paga na hora, pelo QR do provedor' },
  boleto_online:      { modalidade: 'online', meioFiscal: '15', provedor: 'cobranca', ordem: 20,
                        rotulo: 'Boleto', descricao: 'Emitido no fechamento do pedido' },
  cartao_online:      { modalidade: 'online', meioFiscal: '03', provedor: 'cobranca', ordem: 30,
                        rotulo: 'Cartão online', descricao: 'Ainda não disponível' },
  pix_manual:         { modalidade: 'manual', meioFiscal: '17', provedor: null, ordem: 40,
                        rotulo: 'PIX', descricao: 'A loja manda a chave e confere o comprovante' },
  dinheiro:           { modalidade: 'manual', meioFiscal: '01', provedor: null, ordem: 50,
                        rotulo: 'Dinheiro', descricao: 'Na entrega ou na retirada, com troco' },
  credito_presencial: { modalidade: 'manual', meioFiscal: '03', provedor: null, ordem: 60,
                        rotulo: 'Cartão de crédito', descricao: 'Maquininha na entrega ou na retirada' },
  debito_presencial:  { modalidade: 'manual', meioFiscal: '04', provedor: null, ordem: 70,
                        rotulo: 'Cartão de débito', descricao: 'Maquininha na entrega ou na retirada' },
};

/**
 * Métodos que existem no vocabulário mas NÃO podem ser ativados nesta fase.
 *
 * `cartao_online` está aqui porque a peça que falta não é a linha na tabela:
 * é a tokenização do cartão, o CREDIT_CARD do provedor e o estorno. Deixá-lo
 * ativável agora daria ao lojista um botão que gera pedido que ninguém cobra.
 * Ele aparece na tela como "Em breve", e a API recusa ativá-lo.
 */
const INDISPONIVEIS = new Set(['cartao_online']);

const eh = (v) => Number(v) === 1;

function migrarMetodos(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loja_metodos_pagamento (
      metodo TEXT PRIMARY KEY,
      modalidade TEXT NOT NULL,
      meioFiscal TEXT NOT NULL,
      provedor TEXT,
      ativo INTEGER NOT NULL DEFAULT 0,
      entrega INTEGER NOT NULL DEFAULT 0,
      retirada INTEGER NOT NULL DEFAULT 0,
      noLocal INTEGER NOT NULL DEFAULT 0,
      ordem INTEGER NOT NULL DEFAULT 0
    );
  `);

  /* A tabela VAZIA é o registro de que o legado ainda não foi lido. Não há
     flag em `loja_config` de propósito: uma flag pode divergir do estado real
     da tabela, e aí ou a migração roda de novo (reescrevendo a escolha do
     lojista) ou nunca roda. A contagem não diverge de si mesma.

     Por isso, SEM `loja_config` não se semeia nada. Esta função é chamada
     duas vezes no boot — pelo `db-schema.js`, que roda antes de a
     `loja_config` nascer, e pelo `migrarLojaDB`, que roda depois. Semear na
     primeira deixaria a tabela não-vazia com o legado nunca lido, e a loja
     ficaria sem método NENHUM para sempre. Foi o que aconteceu em 30/09 com
     tenant novo, e o que a etapa A11 guarda. */
  const c = lerConfigLoja(db);
  const vazia = db.prepare('SELECT COUNT(*) c FROM loja_metodos_pagamento').get().c === 0;
  if (vazia && !c) return;

  /* A semente é incondicional daqui para baixo, e é assim que um método
     acrescentado ao catálogo depois alcança quem já migrou: ele nasce
     desligado. Ligar seria mudar o que a loja aceita sem ninguém pedir. */
  const semear = db.prepare(`INSERT OR IGNORE INTO loja_metodos_pagamento
      (metodo, modalidade, meioFiscal, provedor, ativo, entrega, retirada, noLocal, ordem)
    VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)`);
  for (const [metodo, d] of Object.entries(CATALOGO)) {
    semear.run(metodo, d.modalidade, d.meioFiscal, d.provedor, d.ordem);
  }

  if (vazia) migrarDoLegado(db, c);
}

/** A configuração da loja, ou null enquanto a tabela ainda não existe. */
function lerConfigLoja(db) {
  try {
    return db.prepare('SELECT pagamentoModo FROM loja_config WHERE id = 1').get() || null;
  } catch { return null; }
}

/**
 * Traduz `loja_config.pagamentoModo` para linhas da tabela, UMA VEZ.
 *
 * A tradução não é uma escolha de desenho: ela é a leitura do que o checkout
 * antigo fazia em cada modo, e o compromisso é que nenhuma loja mude de
 * comportamento por causa desta migração.
 *
 *   'nenhum'        → o checkout oferecia pix, dinheiro e cartão, nenhum
 *                     cobrado online. Viram os quatro manuais (o botão único
 *                     "Cartão", que mandava tPag 03, abre em crédito e débito,
 *                     porque 03 e 04 são códigos diferentes e o cliente sabe
 *                     qual vai passar).
 *   'pix'           → o checkout FORÇAVA Pix e escondia o resto
 *                     (`loja-routes.js:1649`). Vira só `pix_online`.
 *   'boleto'        → mesma coisa pelo boleto.
 *   'pix-ou-boleto' → os dois online, e nada manual.
 *
 * Ou seja: quem não cobrava online continua sem cobrar, e quem cobrava
 * continua cobrando o mesmo. A migração nunca LIGA um método online que o
 * `pagamentoModo` não pedia — é a garantia de que ninguém acorda cobrando
 * pela internet sem ter escolhido isso.
 *
 * `entrega` e `retirada` saem dos serviços que a loja já tem habilitados:
 * ativar um método para um atendimento que a loja não faz seria oferecer ao
 * lojista uma combinação que o checkout nunca vai mostrar.
 */
function migrarDoLegado(db, cfg) {
  const c = cfg || lerConfigLoja(db);
  if (!c) return;              // `loja_config` ainda não existe neste tenant

  /* Os DOIS atendimentos, sempre, e não os serviços que a loja tem hoje.
     São duas camadas diferentes: estas colunas guardam a escolha do LOJISTA
     sobre onde cada método vale, e o serviço ligado ou não é da loja —
     `disponiveis` já confere o `loja_config` antes de oferecer qualquer
     coisa. Amarrar as duas na migração congelava um retrato: a loja que
     ligasse a entrega no dia seguinte ficaria com todos os métodos marcados
     só para retirada, e o checkout da entrega não ofereceria nada.
     O legado também não distinguia — aquele checkout mostrava as mesmas
     formas nos dois atendimentos. */
  const ligar = db.prepare(`UPDATE loja_metodos_pagamento
      SET ativo = 1, entrega = 1, retirada = 1 WHERE metodo = ?`);

  const MANUAIS = ['pix_manual', 'dinheiro', 'credito_presencial', 'debito_presencial'];
  const modo = c.pagamentoModo || 'nenhum';
  const online = modo === 'pix' ? ['pix_online']
    : modo === 'boleto' ? ['boleto_online']
    : modo === 'pix-ou-boleto' ? ['pix_online', 'boleto_online']
    : [];

  /* Modo online configurado mas SEM provedor que o emita: aquele checkout
     caía nos três manuais, porque `pixNoSite` exigia as duas coisas juntas
     (`loja-routes.js:1054`, até 30/09). Migrar só o online deixaria a loja
     sem forma nenhuma — medido em 30/09 no `cantinhoverde`, que tem
     `pagamentoModo = 'pix'` e nenhuma conta Asaas ativa.
     O online fica ligado do mesmo jeito: no dia em que a conta for
     configurada ele aparece sozinho, ao lado dos manuais. */
  const temProvedor = online.some((m) => provedorPronto(db, m));
  const alvos = online.length && temProvedor ? online : [...online, ...MANUAIS];

  for (const m of alvos) ligar.run(m);
}

/**
 * O provedor de cobrança sabe mesmo emitir este método?
 *
 * Tabela dizendo "ativo" não basta: sem conta financeira com Asaas o pedido
 * nasceria esperando um Pix que ninguém emite, e o cliente ficaria olhando uma
 * tela de pagamento vazia. Quem responde é a mesma fiação do financeiro, e a
 * pergunta é por MÉTODO — um provedor pode gerar Pix e não gerar boleto.
 */
function provedorPronto(db, metodo) {
  const fn = MEIOS_ONLINE[metodo];
  if (!fn) return false;
  try {
    const orq = require('./boleto-orchestrator');
    const conta = orq.getContaFinanceiraPadraoBoleto(db);
    if (!conta) return false;
    const r = orq._internal.getProvedorConfig(db, conta);
    return !!(r && typeof r.modulo[fn] === 'function');
  } catch { return false; }
}

/** As linhas da tabela, com o rótulo e a modalidade do catálogo junto. */
function listar(db) {
  const linhas = db.prepare('SELECT * FROM loja_metodos_pagamento ORDER BY ordem, metodo').all();
  return linhas.filter((l) => CATALOGO[l.metodo]).map((l) => ({
    metodo: l.metodo,
    modalidade: CATALOGO[l.metodo].modalidade,
    meioFiscal: CATALOGO[l.metodo].meioFiscal,
    rotulo: CATALOGO[l.metodo].rotulo,
    descricao: CATALOGO[l.metodo].descricao,
    ativo: eh(l.ativo),
    entrega: eh(l.entrega),
    retirada: eh(l.retirada),
    indisponivel: INDISPONIVEIS.has(l.metodo),
    provedorPronto: CATALOGO[l.metodo].modalidade === 'online' ? provedorPronto(db, l.metodo) : true,
  }));
}

/**
 * O que o consumidor pode escolher, para este atendimento.
 *
 * É esta função, e não o navegador, que decide. O checkout a usa para montar a
 * tela e a validação do pedido a usa de novo para conferir o que voltou — as
 * duas leituras precisam vir da MESMA fonte, senão a tela mostra uma coisa e o
 * servidor aceita outra.
 */
function disponiveis(db, atendimento, cfg) {
  const col = atendimento === 'entrega' ? 'entrega' : atendimento === 'retirada' ? 'retirada' : null;
  if (!col) return [];
  /* Serviço desligado na loja não tem método nenhum, mesmo com a linha ativa:
     quem manda sobre o atendimento é o `loja_config`, e a tabela de métodos
     não pode reabrir uma porta que a loja fechou. */
  if (col === 'entrega' && !eh(cfg && cfg.servicoDelivery)) return [];
  if (col === 'retirada' && !eh(cfg && cfg.servicoRetirada)) return [];

  return listar(db).filter((m) => m.ativo && m[col] && !m.indisponivel && m.provedorPronto);
}

/**
 * Valida o método que voltou do navegador e devolve o que o pedido vai gravar.
 *
 * Devolve `{ erro }` ou `{ metodo, meioFiscal, modalidade }`. O `meioFiscal`
 * sai daqui e NUNCA do corpo da requisição: é ele que vai para a nota, e um
 * cliente que escolhesse o próprio tPag emitiria documento fiscal errado.
 */
function validar(db, metodo, atendimento, cfg) {
  const bruto = String(metodo || '');
  if (!bruto) return { erro: 'Escolha uma forma de pagamento.' };

  const abertos = disponiveis(db, atendimento, cfg);

  /* 'pix' sem sufixo vem da aba que ficou aberta com o checkout anterior, que
     tinha um botão "PIX" só. Qual dos dois ele era dependia da loja, e é essa
     ambiguidade que a tabela desfez — aqui ela se resolve pelo que está no
     ar, preferindo o online, que é o que aquele checkout fazia quando havia
     cobrança configurada. */
  const m = bruto !== 'pix' ? bruto
    : (abertos.find((d) => d.metodo === 'pix_online') ? 'pix_online' : 'pix_manual');

  if (!CATALOGO[m]) return { erro: 'Forma de pagamento desconhecida.' };

  const ok = abertos.find((d) => d.metodo === m);
  if (!ok) {
    /* Uma mensagem só para todos os motivos (desativado, atendimento errado,
       provedor fora do ar, método em breve). Detalhar diria a quem adultera a
       requisição exatamente qual porta tentar em seguida, e para o cliente
       honesto a diferença não muda o que ele faz: escolher outra. */
    return { erro: 'Esta forma de pagamento não está disponível para este pedido.' };
  }
  return { metodo: m, meioFiscal: ok.meioFiscal, modalidade: ok.modalidade };
}

/** Grava a escolha do lojista. Só mexe no que veio, e nunca apaga linha. */
function salvar(db, entradas) {
  const up = db.prepare(`UPDATE loja_metodos_pagamento
      SET ativo = ?, entrega = ?, retirada = ? WHERE metodo = ?`);
  const tx = db.transaction((lista) => {
    for (const e of lista) {
      const m = String(e && e.metodo || '');
      if (!CATALOGO[m]) continue;
      /* O que não pode ser ativado não é ativado nem por requisição direta: a
         tela o mostra desabilitado, e esta linha é a garantia de verdade. */
      const ativo = INDISPONIVEIS.has(m) ? 0 : (e.ativo ? 1 : 0);
      up.run(ativo, e.entrega ? 1 : 0, e.retirada ? 1 : 0, m);
    }
  });
  tx(Array.isArray(entradas) ? entradas : []);
}

module.exports = {
  CATALOGO, INDISPONIVEIS,
  migrarMetodos, migrarDoLegado, provedorPronto,
  listar, disponiveis, validar, salvar,
};
