/**
 * nfce-routes.js — Emissão de NFC-e modelo 65 (varejo · consumidor final).
 *
 * Reaproveita certificado + emitente + lib node-sped-nfe de nfe-emit-routes.
 * NFC-e tem particularidades:
 *   - modelo 65, tpImp 4 (DANFCE)
 *   - indPres 1 (presencial), indFinal 1 (consumidor final)
 *   - tag <pag> obrigatória
 *   - CSC + CSCid obrigatórios para geração do QR code
 *   - destinatário opcional até R$ 200 (com CPF acima disso)
 *
 * O PDV emite só modelo 65. A natureza de operação (nfce_config.pdvTipoOperacaoId)
 * é quem decide o CFOP dos itens e o que a venda dispara além do documento:
 * conta a receber (geraFinanceiro) e baixa de estoque (movimentaEstoque), com o
 * vencimento das parcelas saindo da política de prazo padrão do balcão
 * (pdvPoliticaPrazoId). Mesmo contrato que a NF avulsa respeita.
 *
 * Schema novo:
 *   nfce_config    — série/próximo número/CSC/CSCid (separado da NF-e mod 55)
 *   nfce           — NFC-e emitida
 *   nfce_itens     — itens da venda
 *   nfce_pagamentos — formas de pagamento
 *
 * Endpoints:
 *   GET  /api/nfce/config
 *   PUT  /api/nfce/config
 *   POST /api/nfce/emitir
 *   GET  /api/nfce
 *   GET  /api/nfce/:id
 *   GET  /api/nfce/:id/xml
 *   POST /api/nfce/:id/cancelar
 */

const { codigoUF, gerarCNF } = require('./nfe-ibge');
const { montarNFeProc } = require('./nfe-proc');
const { resolverEstab, serieAtual, avancarSerie } = require('./nfe-emit-routes');
const { erroMeioPorCpfCnpj } = require('./meios-pagamento');
const { getEstabelecimentoAtivo } = require('./estabelecimentos-routes');
const { parsePrazo, vencimentosDoPrazo, dividirValor } = require('./prazo-pagamento');

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* ok */ } }

// ─── Natureza de operação do balcão ─────────────────────────────────────────
// O PDV tem UMA natureza, escolhida em PDV · Config (nfce_config.pdvTipoOperacaoId).
// É ela que decide o que a venda dispara além do documento — conta a receber
// quando geraFinanceiro=1, baixa de estoque quando movimentaEstoque=1 —, o mesmo
// contrato que a NF avulsa já respeita. Sem natureza configurada a emissão para:
// venda que não sabe o que movimenta é pior do que venda que não sai.
function naturezaDoPdv(db) {
  const cfg = db.prepare('SELECT pdvTipoOperacaoId FROM nfce_config WHERE id = 1').get() || {};
  if (!cfg.pdvTipoOperacaoId) return null;
  return db.prepare('SELECT * FROM tipos_operacao WHERE id = ?').get(cfg.pdvTipoOperacaoId) || null;
}

/**
 * A natureza desta emissão: a informada por quem chamou, ou a do PDV.
 *
 * O `db` é o do TENANT da requisição, então buscar o id dentro dele é o que
 * garante o isolamento: um id de outro tenant simplesmente não existe aqui e a
 * emissão para. Não há caminho em que a natureza venha pronta de fora.
 *
 * Omitir `tipoOperacaoId` é o caminho de sempre, e é por isso que PDV e
 * restaurante não mudam de comportamento: os dois não informam nada e continuam
 * caindo no `naturezaDoPdv`. Informar NÃO grava em `nfce_config` — a escolha
 * vale para esta nota e só para ela.
 */
function naturezaDaEmissao(db, tipoOperacaoId) {
  if (tipoOperacaoId == null || tipoOperacaoId === '') return naturezaDoPdv(db);
  const id = Number(tipoOperacaoId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Natureza de operação inválida para esta emissão');
  }
  const nat = db.prepare('SELECT * FROM tipos_operacao WHERE id = ?').get(id);
  if (!nat) throw new Error('Natureza de operação não encontrada nesta empresa');
  if (Number(nat.ativo) === 0) {
    throw new Error(`A natureza "${nat.descricao}" está inativa`);
  }
  return nat;
}

/**
 * O pedido comercial que originou esta nota — ou null.
 *
 * Mesma defesa da natureza: o pedido é procurado NO BANCO DO TENANT, então um
 * id de outro tenant não é encontrado e a emissão para antes de gravar. É a
 * única barreira que não depende de ninguém lembrar de checar.
 */
function pedidoDaEmissao(db, pedidoId) {
  if (pedidoId == null || pedidoId === '') return null;
  const id = Number(pedidoId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Pedido de origem inválido');
  const ped = db.prepare('SELECT id FROM pedidos WHERE id = ?').get(id);
  if (!ped) throw new Error('Pedido de origem não encontrado nesta empresa');
  return ped.id;
}

// Política de prazo padrão do balcão (nfce_config.pdvPoliticaPrazoId): de onde
// saem os meios de pagamento oferecidos e o vencimento das parcelas da CR.
function politicaDoPdv(db) {
  const cfg = db.prepare('SELECT pdvPoliticaPrazoId FROM nfce_config WHERE id = 1').get() || {};
  if (!cfg.pdvPoliticaPrazoId) return null;
  return db.prepare('SELECT * FROM politicas_prazo WHERE id = ? AND ativo = 1').get(cfg.pdvPoliticaPrazoId) || null;
}

// Pessoa da venda: a CR precisa de pessoaId (NOT NULL). Com CPF/CNPJ na mão,
// reaproveita o cadastro e só cria o que faltar — mesmo caminho que o antigo
// ramo NFe do PDV usava.
function pessoaDaVenda(db, cpfCnpj, nome) {
  const digits = String(cpfCnpj || '').replace(/\D/g, '');
  if (!digits) return null;
  let pessoa = db.prepare('SELECT * FROM pessoas WHERE cpfCnpj = ?').get(digits);
  if (!pessoa) {
    db.prepare('INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial) VALUES (?, ?, ?)').run(
      digits, digits.length === 14 ? 'PJ' : 'PF',
      String(nome || '').trim() || `Consumidor ${digits}`);
    pessoa = db.prepare('SELECT * FROM pessoas WHERE cpfCnpj = ?').get(digits);
  }
  return pessoa;
}

// Parcelas da CR conforme a política: 'prazo' abre uma por vencimento
// (30/60/90 → três), 'vista' e ausência de política fecham em uma só, vencendo
// no dia da venda.
function parcelasDaPolitica(politica, total, dataEmissao) {
  const dias = politica && politica.tipo === 'prazo' ? parsePrazo(politica.prazoDias) : null;
  if (!dias || !dias.length) {
    return [{ valor: Number(Number(total).toFixed(2)), dataVencimento: dataEmissao }];
  }
  const valores = dividirValor(total, dias.length);
  return vencimentosDoPrazo(dataEmissao, dias).map((venc, i) => ({
    valor: valores[i], dataVencimento: venc,
  }));
}

// Os efeitos que a natureza pede, disparados só depois de a SEFAZ autorizar.
// Roda dentro da transação de gravação da NFC-e.
function aplicarEfeitosDaNatureza(db, { nfceId, numero, natureza, politica, pessoaId, itens, valorTotal, dataEmissao, tPag, lotesDaVenda }) {
  if (!natureza) return;

  if (Number(natureza.geraFinanceiro) && pessoaId) {
    const parcelas = parcelasDaPolitica(politica, valorTotal, dataEmissao);
    const grupo = parcelas.length > 1 ? `nfce-${nfceId}` : null;
    const insCR = db.prepare(`
      INSERT INTO contas_a_receber (pessoaId, nfceId, descricao, valor, dataEmissao,
        dataVencimento, formaPagamento, status, origem,
        parcelaNumero, totalParcelas, grupoParcelaId, dataCriacao)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pendente', 'nfce', ?, ?, ?, CURRENT_TIMESTAMP)`);
    parcelas.forEach((p, i) => {
      insCR.run(pessoaId, nfceId, `NFC-e ${numero}`, p.valor, dataEmissao,
        p.dataVencimento, tPag || null, i + 1, parcelas.length, grupo);
    });
  }

  if (Number(natureza.movimentaEstoque)) {
    const { resolverDeposito, contextoDeSaida } = require('./estoque-routes');
    // Toda saída leva o custo (custoMedioAnterior) e o saldo depois dela: sem
    // isso o relatório de lucro do balcão cairia no custo de hoje, e não no da
    // data da venda.
    const insMov = db.prepare(`
      INSERT INTO movimentacoes_estoque
        (produtoId, tipo, quantidade, origem, origemId, observacao, data, depositoId, loteId,
         custoMedioAnterior, custoMedioPosterior, saldoPosterior)
      VALUES (?, 'saida', ?, 'nfce', ?, ?, ?, ?, ?, ?, ?, ?)`);
    const sair = (produtoId, qtd, obs, loteId) => {
      const ctx = contextoDeSaida(db, produtoId, qtd);
      insMov.run(produtoId, qtd, nfceId, obs, dataEmissao, resolverDeposito(db, { produtoId }), loteId,
        ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior);
    };
    const tipoDe = db.prepare('SELECT tipoProduto, descricao FROM produtos WHERE id = ?');
    const componentesDe = db.prepare('SELECT produtoFilhoId, quantidade FROM produto_kit_itens WHERE produtoPaiId = ?');
    itens.forEach((it, i) => {
      if (!it.produtoId) return;
      // Kit não tem saldo próprio: sai cada componente, na proporção da
      // composição. Mesma regra do pedido (reservas-routes.explodirItensPedido).
      const prod = tipoDe.get(it.produtoId);
      if (prod && prod.tipoProduto === 'kit') {
        for (const c of componentesDe.all(it.produtoId)) {
          sair(c.produtoFilhoId, Number(it.quantidade) * Number(c.quantidade),
            `Saída pela NFC-e ${numero} · componente de ${prod.descricao}`, null);
        }
        return;
      }
      const alocacoes = lotesDaVenda?.[i]?.alocacoes || [];
      if (!alocacoes.length) {
        // Produto que não rastreia lote (ou módulo Farmácia desligado):
        // uma movimentação, sem lote — comportamento histórico do PDV.
        sair(it.produtoId, Number(it.quantidade), `Saída pela NFC-e ${numero}`, null);
        return;
      }
      // Uma movimentação por lote, para o saldo por lote continuar fechando —
      // é isso que a ANVISA compara no SNGPC.
      for (const a of alocacoes) {
        sair(it.produtoId, Number(a.quantidade), `Saída pela NFC-e ${numero} · lote ${a.numero}`, a.loteId);
      }
    });

    if (lotesDaVenda) {
      const { baixarAlocacoes } = require('./farmacia/fefo');
      baixarAlocacoes(db, lotesDaVenda.flatMap(l => l.alocacoes || []));
    }
  }
}

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfce_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tpAmb INTEGER DEFAULT 2,
      serie INTEGER DEFAULT 1,
      proximoNumero INTEGER DEFAULT 1,
      cscId TEXT,
      csc TEXT,
      observacao TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nfce (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero INTEGER,
      serie INTEGER,
      chaveAcesso TEXT UNIQUE,
      protocoloAutorizacao TEXT,
      tpAmb INTEGER,
      dataEmissao TEXT DEFAULT CURRENT_TIMESTAMP,
      valorProdutos REAL DEFAULT 0,
      valorDesconto REAL DEFAULT 0,
      valorTotal REAL DEFAULT 0,
      consumidorCpfCnpj TEXT,
      consumidorNome TEXT,
      xmlAssinado TEXT,
      qrCodeUrl TEXT,
      urlChave TEXT,
      statusSefaz TEXT DEFAULT 'pendente',
      rejeicaoMotivo TEXT,
      motivoCancelamento TEXT,
      dataCancelamento TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_nfce_status ON nfce(statusSefaz);
    CREATE INDEX IF NOT EXISTS idx_nfce_emissao ON nfce(dataEmissao);

    CREATE TABLE IF NOT EXISTS nfce_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nfceId INTEGER NOT NULL,
      produtoId INTEGER,
      sku TEXT,
      descricao TEXT NOT NULL,
      ncm TEXT,
      cfop TEXT,
      unidade TEXT DEFAULT 'UN',
      quantidade REAL NOT NULL,
      precoUnitario REAL NOT NULL,
      valorTotal REAL NOT NULL,
      FOREIGN KEY (nfceId) REFERENCES nfce(id)
    );

    CREATE TABLE IF NOT EXISTS nfce_pagamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nfceId INTEGER NOT NULL,
      tPag TEXT NOT NULL,
      valor REAL NOT NULL,
      FOREIGN KEY (nfceId) REFERENCES nfce(id)
    );
  `);
  db.prepare('INSERT OR IGNORE INTO nfce_config (id, tpAmb, serie, proximoNumero) VALUES (1, 2, 1, 1)').run();
  alterSafe(db, 'ALTER TABLE nfce_config ADD COLUMN pdvExigirCpfSempre INTEGER DEFAULT 0');
  alterSafe(db, `ALTER TABLE nfce_config ADD COLUMN pdvModoImpressao TEXT DEFAULT 'nenhum'`);   // 'nenhum' | 'termico-58' | 'termico-80' | 'a4' | 'email'
  // limiteNFCe, pdvModeloPadrao, pdvFormaPagamentoPadrao e pdvExigirClienteCadastrado
  // eram da decisão automática NFC-e/NFe, que saiu junto com o modelo 55 (2026-08-26).
  // Em tenant já provisionado as colunas continuam lá, sem leitor.
  // Natureza de operação e política de prazo do balcão (2026-08-26): quem decide
  // CR/estoque e o vencimento das parcelas. Espelhados em db-schema.js — tenant
  // existente não passa por aqui (ver scripts/migrate-pdv-natureza.js).
  alterSafe(db, 'ALTER TABLE nfce_config ADD COLUMN pdvTipoOperacaoId INTEGER');
  alterSafe(db, 'ALTER TABLE nfce_config ADD COLUMN pdvPoliticaPrazoId INTEGER');
  alterSafe(db, 'ALTER TABLE nfce ADD COLUMN tipoOperacaoId INTEGER');
  alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN nfceId INTEGER');
  // Vínculo com o pedido comercial (2026-09-21). NULL no PDV e no restaurante;
  // só a emissão originada de pedido carimba. O porquê de o índice ser PARCIAL
  // está no db-schema.js, junto do espelho que alcança tenant já existente.
  alterSafe(db, 'ALTER TABLE nfce ADD COLUMN pedidoId INTEGER');
  alterSafe(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_nfce_pedido_autorizada
                 ON nfce(pedidoId) WHERE pedidoId IS NOT NULL AND statusSefaz = 'autorizada'`);
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : '';
}

function carregarEmitente(db, estab = null) {
  const f = (estab && !estab.matriz)
    ? estab
    : db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get();
  if (!f) throw new Error('Emitente não cadastrado');
  if (!f.cnpj) throw new Error('Emitente sem CNPJ');
  if (!f.uf) throw new Error('Emitente sem UF');
  if (!f.inscricaoEstadual) throw new Error('Emitente sem Inscrição Estadual');
  return f;
}

function carregarCert(db, estab = null) {
  const cert = (estab && !estab.matriz)
    ? db.prepare('SELECT certificadoBase64, senhaCriptografada FROM certificado_digital WHERE estabelecimentoId = ?').get(estab.id)
    : db.prepare('SELECT certificadoBase64, senhaCriptografada FROM certificado_digital WHERE id = 1').get();
  if (!cert) throw new Error('Certificado digital não cadastrado');
  return {
    pfx: Buffer.from(cert.certificadoBase64, 'base64'),
    senha: require('./cert-senha').decifrarSenha(cert.senhaCriptografada, cert.certificadoBase64)
  };
}

async function getTools(db, estab = null) {
  const mod = await import('node-sped-nfe');
  const { Tools } = mod;
  const cfg = db.prepare('SELECT * FROM nfce_config WHERE id = 1').get();
  // CSC é por-CNPJ: matriz usa o nfce_config; filial usa o CSC da própria linha.
  const csc = (estab && !estab.matriz) ? estab.csc : cfg.csc;
  const cscId = (estab && !estab.matriz) ? estab.cscId : cfg.cscId;
  if (!csc || !cscId) throw new Error('CSC e CSCid obrigatórios para NFC-e — cadastre na configuração (ou no estabelecimento)');
  const f = carregarEmitente(db, estab);
  const cert = carregarCert(db, estab);
  return new Tools(
    { mod: '65', tpAmb: cfg.tpAmb, UF: f.uf, versao: '4.00', CNPJ: f.cnpj.replace(/\D/g, ''), CSC: csc, CSCid: cscId },
    { pfx: cert.pfx, senha: cert.senha }
  );
}

async function emitirNFCe(db, payload) {
  const { Make } = await import('node-sped-nfe');
  // Multi-loja: estabelecimento emissor (payload.estabelecimentoId; NULL = matriz).
  const estab = resolverEstab(db, payload.estabelecimentoId);
  const tools = await getTools(db, estab);
  const cfg = db.prepare('SELECT * FROM nfce_config WHERE id = 1').get();
  const emit = carregarEmitente(db, estab);

  const itens = payload.itens || [];
  if (!itens.length) throw new Error('Informe ao menos 1 item');

  const pagamentos = payload.pagamentos || [];
  if (!pagamentos.length) throw new Error('Informe a forma de pagamento');

  // A natureza manda no CFOP dos itens e nos efeitos pós-autorização.
  const natureza = naturezaDaEmissao(db, payload.tipoOperacaoId);
  if (!natureza) {
    throw new Error('Natureza de operação do PDV não configurada — defina em PDV · Configurações');
  }
  if (!Number(natureza.emiteNFe)) {
    throw new Error(`A natureza "${natureza.descricao}" não emite documento fiscal — escolha outra em PDV · Configurações`);
  }
  const politica = politicaDoPdv(db);
  // Origem opcional. Validado ANTES de falar com a SEFAZ: descobrir que o
  // pedido não existe depois de a nota estar autorizada não teria conserto.
  const pedidoOrigemId = pedidoDaEmissao(db, payload.pedidoId);

  // Consumidor identificado e com whitelist de meios: o balcão respeita a mesma
  // regra do pedido. Sem CPF/CNPJ não há cliente a consultar e nada é barrado.
  for (const p of pagamentos) {
    const erroMeio = erroMeioPorCpfCnpj(db, payload.consumidorCpfCnpj, p.tPag, '', 'pdv');
    if (erroMeio) throw new Error(erroMeio);
  }

  const cpfCnpjCons = (payload.consumidorCpfCnpj || '').replace(/\D/g, '');
  const valorProdTot = itens.reduce((s, it) => s + Number(it.valorTotal || (it.quantidade * it.precoUnitario) || 0), 0);
  const valorDesc = Number(payload.valorDesconto || 0);
  const vNF = +(valorProdTot - valorDesc).toFixed(2);

  // NFC-e acima de R$ 200 exige CPF/CNPJ identificado
  if (vNF > 200 && !cpfCnpjCons) {
    throw new Error('CPF/CNPJ do consumidor obrigatório para NFC-e acima de R$ 200,00');
  }
  // Conta a receber não existe sem pessoa (contas_a_receber.pessoaId é NOT NULL):
  // natureza que gera financeiro exige consumidor identificado em qualquer valor.
  if (Number(natureza.geraFinanceiro) && !cpfCnpjCons) {
    throw new Error(`CPF/CNPJ do consumidor obrigatório: a natureza "${natureza.descricao}" gera conta a receber`);
  }
  const vPag = pagamentos.reduce((s, p) => s + Number(p.valor || 0), 0);
  if (Math.abs(vPag - vNF) > 0.02) {
    throw new Error(`Soma dos pagamentos (${vPag.toFixed(2)}) não bate com o total (${vNF.toFixed(2)})`);
  }

  // ─── Lote na saída (módulo Farmácia) ───────────────────────────────────────
  // Resolvido AQUI, antes de a nota ganhar número: o grupo <rastro> do XML
  // precisa do lote, e item sem lote disponível não pode queimar numeração.
  // Só vale com o módulo ligado — sem ele o comportamento do PDV é o de sempre.
  let lotesDaVenda = null;
  let dadosMedicamento = null;
  let reservaReceitaIds = [];
  {
    const farmacia = require('./farmacia/farmacia-routes');
    if (farmacia.getFlag(db)) {
      const { resolverLotesDaVenda } = require('./farmacia/fefo');
      const { montarDadosMedicamento } = require('./farmacia/nfe-med-rastro');
      const cfgFarm = farmacia.lerConfig(db);
      lotesDaVenda = resolverLotesDaVenda(db, itens, {
        bloquearVencido: cfgFarm.farmacia_bloquear_vencido !== '0',
      });
      // Falta de registro ANVISA, de PMC ou de lote aparece aqui, no balcão —
      // não como rejeição 840 devolvida pela SEFAZ minutos depois.
      dadosMedicamento = montarDadosMedicamento(db, itens, lotesDaVenda);

      // Teto de preço da CMED. Conferido de novo aqui, e não só na tela: o PDV
      // permite editar o preço do item, e o teto é legal, não é sugestão.
      {
        const { conferirPmc } = require('./farmacia/preco');
        const { erros } = conferirPmc(db, itens, { travar: cfgFarm.farmacia_travar_pmc !== '0' });
        if (erros.length) throw new Error('Preço acima do teto da CMED:\n· ' + erros.join('\n· '));
      }

      // Receita: controlado e antimicrobiano não saem sem os dados que o SNGPC
      // vai cobrar depois. Desligável em config, mas ligado é o padrão.
      //
      // A conferência e a RESERVA do saldo acontecem juntas, numa transação
      // síncrona, aqui — antes dos dois await de rede que vêm a seguir. Sem
      // isso, duas vendas simultâneas da mesma receita passavam as duas na
      // conferência e dispensavam acima do prescrito.
      if (cfgFarm.farmacia_exigir_receita !== '0') {
        const { reservarDispensacao } = require('./farmacia/receita');
        reservaReceitaIds = reservarDispensacao(db, {
          receitaId: payload.receitaId || null, itens, lotesDaVenda,
        });
      }
    }
  }

  const _res = serieAtual(db, estab, cfg, '65');
  const nNF = _res.proximoNumero;
  const serie = _res.serie;
  const cUF = codigoUF(emit.uf);
  if (!cUF) throw new Error(`UF inválida: ${emit.uf}`);

  const NFe = new Make();
  NFe.tagInfNFe({ Id: null, versao: '4.00' });

  NFe.tagIde({
    cUF: String(cUF),
    cNF: gerarCNF(),
    natOp: String(natureza.descricao || 'VENDA AO CONSUMIDOR').substring(0, 60),
    mod: '65',
    serie: String(serie),
    nNF: String(nNF),
    dhEmi: NFe.formatData(),
    tpNF: '1',
    idDest: '1',
    cMunFG: String(emit.codigoMunicipio || '0').padStart(7, '0'),
    tpImp: '4',       // DANFCE retrato
    tpEmis: '1',      // normal
    cDV: '0',
    tpAmb: String(cfg.tpAmb),
    finNFe: '1',
    indFinal: '1',    // consumidor final
    indPres: '1',     // presencial
    indIntermed: '0',
    procEmi: '0',
    verProc: 'LiciteAgora1.0'
  });

  NFe.tagEmit({
    CNPJ: emit.cnpj.replace(/\D/g, ''),
    xNome: emit.razaoSocial,
    xFant: emit.nomeFantasia || emit.razaoSocial,
    IE: emit.inscricaoEstadual.replace(/\D/g, ''),
    CRT: '1'
  });
  NFe.tagEnderEmit({
    xLgr: emit.endereco || 'NAO INFORMADO',
    nro: emit.numero || 'SN',
    xBairro: emit.bairro || 'NAO INFORMADO',
    cMun: String(emit.codigoMunicipio || '0').padStart(7, '0'),
    xMun: emit.cidade || 'NAO INFORMADO',
    UF: emit.uf,
    CEP: (emit.cep || '').replace(/\D/g, ''),
    cPais: '1058',
    xPais: 'BRASIL',
    fone: (emit.telefone || '').replace(/\D/g, '') || undefined
  });

  // Destinatário é opcional em NFC-e quando sem CPF
  if (cpfCnpjCons) {
    const destTag = {};
    if (cpfCnpjCons.length === 14) destTag.CNPJ = cpfCnpjCons;
    else if (cpfCnpjCons.length === 11) destTag.CPF = cpfCnpjCons;
    destTag.xNome = payload.consumidorNome || 'CONSUMIDOR';
    destTag.indIEDest = '9';
    if (payload.consumidorEmail) destTag.email = payload.consumidorEmail;
    NFe.tagDest(destTag);
  }

  // Produtos
  const prodList = itens.map(it => ({
    cProd: String(it.sku || it.produtoId || ('ITEM-' + (itens.indexOf(it) + 1))),
    cEAN: it.codigoBarras || 'SEM GTIN',
    xProd: (it.descricao || '').substring(0, 120),
    NCM: (it.ncm || '00000000').replace(/\D/g, '').padStart(8, '0'),
    CFOP: it.cfop || natureza.cfopInterno || '5102',
    uCom: (it.unidade || 'UN').substring(0, 6),
    qCom: Number(it.quantidade).toFixed(4),
    vUnCom: Number(it.precoUnitario).toFixed(4),
    vProd: Number(it.valorTotal || (it.quantidade * it.precoUnitario)).toFixed(2),
    cEANTrib: it.codigoBarras || 'SEM GTIN',
    uTrib: (it.unidade || 'UN').substring(0, 6),
    qTrib: Number(it.quantidade).toFixed(4),
    vUnTrib: Number(it.precoUnitario).toFixed(4),
    indTot: '1'
  }));
  NFe.tagProd(prodList);

  // ICMS Simples Nacional + PIS/COFINS (mesma lógica de nfe-emit)
  const produtoIds = [...new Set(itens.map(it => it.produtoId).filter(Boolean))];
  const produtosPor = new Map();
  if (produtoIds.length) {
    const rows = db.prepare(`SELECT id, csosn, cstPIS, cstCOFINS, origem FROM produtos WHERE id IN (${produtoIds.map(() => '?').join(',')})`).all(...produtoIds);
    for (const r of rows) produtosPor.set(r.id, r);
  }
  itens.forEach((it, i) => {
    const prod = it.produtoId ? produtosPor.get(it.produtoId) : null;
    const csosn = (prod?.csosn || '102').trim();
    const cstPIS = (prod?.cstPIS || '49').trim();
    const cstCOFINS = (prod?.cstCOFINS || '49').trim();
    const origem = String(prod?.origem || it.origem || '0');
    if (csosn === '101' || csosn === '201') {
      NFe.tagProdICMSSN(i, { orig: origem, CSOSN: csosn, pCredSN: '0.00', vCredICMSSN: '0.00' });
    } else if (csosn === '500') {
      NFe.tagProdICMSSN(i, { orig: origem, CSOSN: csosn, vBCSTRet: '0.00', vICMSSTRet: '0.00', vBCSTDest: '0.00', vICMSSTDest: '0.00' });
    } else {
      NFe.tagProdICMSSN(i, { orig: origem, CSOSN: csosn });
    }
    NFe.tagProdPIS(i, { CST: cstPIS, vBC: '0.00', pPIS: '0.00', vPIS: '0.00' });
    NFe.tagProdCOFINS(i, { CST: cstCOFINS, vBC: '0.00', pCOFINS: '0.00', vCOFINS: '0.00' });
  });

  NFe.tagTotal({ ICMSTot: {
    vDesc: valorDesc.toFixed(2),
    vNF: vNF.toFixed(2)
  }});
  NFe.tagTransp({ modFrete: 9 }); // 9 = sem transporte (NFC-e presencial)

  // Pagamentos — um detPag por forma
  NFe.tagDetPag(pagamentos.map(p => ({
    indPag: 0,
    tPag: String(p.tPag).padStart(2, '0'),
    vPag: Number(p.valor).toFixed(2)
  })));

  let xmlRaw = NFe.xml();

  // Grupos <med> e <rastro> do medicamento (NT 2021.004). Entram AQUI, entre a
  // montagem e a assinatura, porque a lib node-sped-nfe declara tagMed/tagRastro
  // mas as duas lançam "não implementado!". Assinar depois é o que torna a
  // injeção segura. Ver farmacia/nfe-med-rastro.js.
  if (dadosMedicamento && dadosMedicamento.length) {
    const { injetarMedRastro } = require('./farmacia/nfe-med-rastro');
    xmlRaw = injetarMedRastro(xmlRaw, dadosMedicamento);
  }

  // Daqui até a gravação existe reserva de saldo de receita em aberto. Qualquer
  // saída por exceção (certificado, rede, SEFAZ fora do ar) tem de devolver o
  // saldo, senão a receita fica travada por uma venda que nunca aconteceu.
  let xmlAssinado, respStr;
  try {
    xmlAssinado = await tools.xmlSign(xmlRaw);
    const resposta = await tools.sefazEnviaLote(xmlAssinado, { indSinc: 1 });
    respStr = typeof resposta === 'string' ? resposta : JSON.stringify(resposta);
  } catch (err) {
    if (reservaReceitaIds.length) {
      require('./farmacia/receita').liberarDispensacao(db, reservaReceitaIds);
    }
    throw err;
  }

  const cStatLote = tag(respStr, 'cStat');
  const xMotivoLote = tag(respStr, 'xMotivo');
  const protNFeMatch = respStr.match(/<protNFe[^>]*>([\s\S]*?)<\/protNFe>/);
  const protInner = protNFeMatch ? protNFeMatch[1] : '';
  const cStat = tag(protInner, 'cStat') || cStatLote;
  const xMotivo = tag(protInner, 'xMotivo') || xMotivoLote;
  const protocolo = tag(protInner, 'nProt');
  const chave = tag(protInner, 'chNFe') || (xmlAssinado.match(/Id="NFe(\d{44})"/)?.[1] || null);

  const qrMatch = xmlAssinado.match(/<qrCode[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/qrCode>/);
  const qrCodeUrl = qrMatch ? qrMatch[1].trim() : null;
  const urlChMatch = xmlAssinado.match(/<urlChave[^>]*>([\s\S]*?)<\/urlChave>/);
  const urlChave = urlChMatch ? urlChMatch[1].trim() : null;

  let id;
  const tx = db.transaction(() => {
    const autorizada = cStat === '100' || cStat === '150';
    const xmlFinal = autorizada ? montarNFeProc(xmlAssinado, respStr) : xmlAssinado;

    const r = db.prepare(`INSERT INTO nfce
      (numero, serie, chaveAcesso, protocoloAutorizacao, tpAmb, valorProdutos, valorDesconto, valorTotal,
       consumidorCpfCnpj, consumidorNome, xmlAssinado, qrCodeUrl, urlChave,
       statusSefaz, rejeicaoMotivo, tipoOperacaoId, pedidoId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      nNF, serie, chave, protocolo, cfg.tpAmb,
      valorProdTot, valorDesc, vNF,
      cpfCnpjCons || null, payload.consumidorNome || null,
      xmlFinal, qrCodeUrl, urlChave,
      autorizada ? 'autorizada' : 'rejeitada',
      autorizada ? null : `cStat=${cStat} · ${xMotivo}`,
      natureza.id,
      pedidoOrigemId
    );
    id = r.lastInsertRowid;

    const insItem = db.prepare(`INSERT INTO nfce_itens
      (nfceId, produtoId, sku, descricao, ncm, cfop, unidade, quantidade, precoUnitario, valorTotal, loteId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    itens.forEach((it, i) => {
      // `loteId` do item guarda o lote quando a quantidade saiu de um só —
      // que é o caso do balcão. Quando a quantidade atravessa dois lotes, a
      // verdade completa está nas movimentações de estoque (uma por lote) e
      // no grupo <rastro> do XML, que aceita vários.
      const aloc = lotesDaVenda?.[i]?.alocacoes || [];
      insItem.run(id, it.produtoId || null, it.sku || null, it.descricao,
        it.ncm || null, it.cfop || null, it.unidade || 'UN',
        Number(it.quantidade), Number(it.precoUnitario),
        Number(it.valorTotal || (it.quantidade * it.precoUnitario)),
        aloc.length === 1 ? aloc[0].loteId : null);
    });

    const insPag = db.prepare('INSERT INTO nfce_pagamentos (nfceId, tPag, valor) VALUES (?, ?, ?)');
    for (const p of pagamentos) insPag.run(id, String(p.tPag).padStart(2, '0'), Number(p.valor));

    if (autorizada) {
      avancarSerie(db, estab, '65', nNF + 1, 'nfce_config');
      // Efeitos só depois do "autorizada": nota rejeitada não move estoque nem
      // abre cobrança. -3h porque a data que interessa é a do balcão (BRT).
      const dataEmissao = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
      /* `efeitosJaAplicados` existe para o documento poder ser SÓ documento.
         Quem vende pelo balcão não aplicou nada antes, e por isso o padrão é
         aplicar — omitir a chave mantém PDV e restaurante idênticos.
         Quem chega com um pedido comercial já reservou na confirmação e já
         baixou na entrega: repetir aqui baixaria o estoque duas vezes e abriria
         uma segunda conta a receber para a mesma venda (medido em 2026-09-21:
         4 unidades saíram para um pedido de 2, e nasceram 2 CRs).
         Nesta fase nenhum endpoint passa isto — a fronteira existe, o
         consumidor ainda não. */
      if (!payload.efeitosJaAplicados) {
        const pessoa = pessoaDaVenda(db, cpfCnpjCons, payload.consumidorNome);
        aplicarEfeitosDaNatureza(db, {
          nfceId: id, numero: nNF, natureza, politica,
          pessoaId: pessoa ? pessoa.id : null,
          itens, valorTotal: vNF, dataEmissao,
          tPag: String(pagamentos[0].tPag).padStart(2, '0'),
          lotesDaVenda,
        });
      }

      // A reserva feita antes do envio vira consumo e ganha o número da nota.
      if (reservaReceitaIds.length) {
        require('./farmacia/receita').confirmarDispensacao(db, reservaReceitaIds, id);
      }

      // Fila do SNGPC. O dado de dispensação só existe agora — depois não dá
      // para reconstruir prescritor, comprador e lote.
      if (lotesDaVenda) {
        require('./farmacia/sngpc-eventos').registrarVenda(db, {
          nfceId: id, numero: nNF, dataEmissao, itens, lotesDaVenda,
          receitaId: payload.receitaId || null,
        });
      }
    } else if (reservaReceitaIds.length) {
      // Nota rejeitada: o saldo prescrito volta para a receita.
      require('./farmacia/receita').liberarDispensacao(db, reservaReceitaIds);
    }
  });
  tx();

  return { id, cStat, xMotivo, chave, protocolo, nNF, serie, qrCodeUrl, urlChave,
           natureza: { id: natureza.id, codigo: natureza.codigo, descricao: natureza.descricao },
           // null no balcão e no restaurante; preenchido quando a nota veio de
           // um pedido. Quem chamou precisa saber o que foi gravado.
           pedidoId: pedidoOrigemId };
}

function registrarRotas(app, db) {
  migrar(db);

  app.get('/api/nfce/config', (req, res) => {
    try {
      const cfg = db.prepare('SELECT * FROM nfce_config WHERE id = 1').get();
      // Não expor CSC no GET — só retornar um flag se existe
      res.json({ success: true, config: {
        id: cfg.id, tpAmb: cfg.tpAmb, serie: cfg.serie, proximoNumero: cfg.proximoNumero,
        cscId: cfg.cscId || null, cscCadastrado: !!cfg.csc, observacao: cfg.observacao,
        dataAtualizacao: cfg.dataAtualizacao
      }});
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/nfce/config', (req, res) => {
    try {
      const b = req.body || {};
      const atual = db.prepare('SELECT * FROM nfce_config WHERE id = 1').get();
      const novoTpAmb = b.tpAmb != null ? Number(b.tpAmb) : atual.tpAmb;
      let proximoNumero = b.proximoNumero != null ? Number(b.proximoNumero) : atual.proximoNumero;
      const trocouAmb = novoTpAmb !== atual.tpAmb;
      if (trocouAmb && b.proximoNumero == null) proximoNumero = 1;
      db.prepare(`UPDATE nfce_config SET
        tpAmb = ?, serie = ?, proximoNumero = ?, cscId = ?, csc = ?, observacao = ?,
        dataAtualizacao = CURRENT_TIMESTAMP WHERE id = 1`).run(
        novoTpAmb,
        b.serie != null ? Number(b.serie) : atual.serie,
        proximoNumero,
        b.cscId != null ? b.cscId : atual.cscId,
        // Vazio mantém o atual (o campo chega em branco quando não se quer
        // trocar o token). Para apagar de fato, mande cscLimpar.
        b.cscLimpar ? null : (b.csc ? b.csc : atual.csc),
        b.observacao != null ? b.observacao : atual.observacao
      );
      // O GET usa !!cfg.csc; usar `IS NOT NULL` aqui fazia string vazia contar
      // como cadastrada e a tela dizia "CSC cadastrado" logo após salvar sem CSC.
      const linha = db.prepare('SELECT * FROM nfce_config WHERE id = 1').get();
      const atualizado = {
        id: linha.id, tpAmb: linha.tpAmb, serie: linha.serie,
        proximoNumero: linha.proximoNumero, cscId: linha.cscId || null,
        cscCadastrado: !!linha.csc, observacao: linha.observacao,
        dataAtualizacao: linha.dataAtualizacao,
      };
      res.json({ success: true, trocouAmbiente: trocouAmb, config: atualizado });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Busca de produto para PDV (inclui código de barras, exclusivo do NFC-e)
  app.get('/api/nfce/produtos/buscar', (req, res) => {
    // Promoção vigente (tabela de preço com vigência) vale no balcão como vale
    // na loja: `precoPromocional` vem junto, e a tela o usa no lugar do cheio.
    const { precoPromocional } = require('./precos-routes');
    const comPromo = (p) => {
      const promo = precoPromocional(db, p.id, 1);
      return promo ? { ...p, precoPromocional: promo.preco, promocao: promo.tabelaNome } : p;
    };
    try {
      const q = (req.query.q || '').trim();
      if (!q) return res.json({ success: true, produtos: [] });
      const like = `%${q.toLowerCase()}%`;
      // Primeiro tenta match exato por código de barras ou SKU (caso de leitor de código)
      const exato = db.prepare(`SELECT id, sku, descricao, unidade, precoVenda, codigoBarras, ncm, cfopPadrao AS cfop
        FROM produtos WHERE ativo = 1 AND (codigoBarras = ? OR sku = ?) LIMIT 1`).get(q, q);
      if (exato) return res.json({ success: true, produtos: [comPromo(exato)], matchExato: true });

      // Com o módulo Farmácia ligado, o balcão também busca por PRINCÍPIO ATIVO
      // e o resultado vem com tarja, PMC e lista da 344 — sem isso o balconista
      // não sabe o que exige receita antes de bipar. Sem o módulo, a consulta é
      // exatamente a de sempre.
      if (require('./farmacia/farmacia-routes').getFlag(db)) {
        const produtos = db.prepare(`
          SELECT p.id, p.sku, p.descricao, p.unidade, p.precoVenda, p.codigoBarras,
                 p.ncm, p.cfopPadrao AS cfop, p.rastreiaLote,
                 s.substancia, s.tarja, s.pmc, s.regimePreco, s.listaPortaria344,
                 s.antimicrobiano, s.laboratorio, s.tipoProduto
          FROM produtos p
          LEFT JOIN farmacia_medicamento_specs s ON s.produtoId = p.id
          WHERE p.ativo = 1 AND (LOWER(p.sku) LIKE ? OR LOWER(p.descricao) LIKE ?
                                 OR p.codigoBarras LIKE ? OR LOWER(s.substancia) LIKE ?
                                 OR s.ean LIKE ?)
          ORDER BY p.descricao ASC LIMIT 20`).all(like, like, `%${q}%`, like, `%${q}%`);
        return res.json({ success: true, produtos: produtos.map(comPromo), farmacia: true });
      }

      const produtos = db.prepare(`SELECT id, sku, descricao, unidade, precoVenda, codigoBarras, ncm, cfopPadrao AS cfop
        FROM produtos
        WHERE ativo = 1 AND (LOWER(sku) LIKE ? OR LOWER(descricao) LIKE ? OR codigoBarras LIKE ?)
        ORDER BY descricao ASC LIMIT 20`).all(like, like, `%${q}%`);
      res.json({ success: true, produtos: produtos.map(comPromo) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/nfce/emitir', async (req, res) => {
    try {
      const _payload = req.body || {};
      const _e = getEstabelecimentoAtivo(db, req);
      if (_e && !_e.matriz) _payload.estabelecimentoId = _e.id;
      const r = await emitirNFCe(db, _payload);
      res.json({ success: true, ...r });
    } catch (err) {
      console.error('[nfce emitir]', err);
      res.status(400).json({ success: false, error: String(err.message || err) });
    }
  });

  // Configurações de comportamento do PDV (lê/salva sobre nfce_config id=1).
  // Devolve natureza e política já resolvidas: a tela precisa dos meios da
  // política para montar os botões de pagamento, e do que a natureza dispara.
  app.get('/api/pdv/config', (req, res) => {
    try {
      const c = db.prepare(`SELECT pdvTipoOperacaoId, pdvPoliticaPrazoId,
        pdvExigirCpfSempre, pdvModoImpressao FROM nfce_config WHERE id = 1`).get() || {};
      const natureza = naturezaDoPdv(db);
      const politica = politicaDoPdv(db);
      res.json({
        success: true,
        config: {
          pdvTipoOperacaoId: c.pdvTipoOperacaoId || null,
          pdvPoliticaPrazoId: c.pdvPoliticaPrazoId || null,
          pdvExigirCpfSempre: c.pdvExigirCpfSempre ? 1 : 0,
          pdvModoImpressao: c.pdvModoImpressao || 'nenhum',
        },
        natureza: natureza && {
          id: natureza.id, codigo: natureza.codigo, descricao: natureza.descricao,
          emiteNFe: natureza.emiteNFe, geraFinanceiro: natureza.geraFinanceiro,
          movimentaEstoque: natureza.movimentaEstoque, cfopInterno: natureza.cfopInterno,
        },
        politica: politica && {
          id: politica.id, nome: politica.nome, tipo: politica.tipo,
          prazoDias: politica.prazoDias,
          meiosPermitidos: politica.meiosPermitidos ? JSON.parse(politica.meiosPermitidos) : null,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/pdv/config', (req, res) => {
    try {
      const b = req.body || {};

      // Natureza é obrigatória: é dela que saem CFOP, conta a receber e estoque.
      const tipoOperacaoId = Number(b.pdvTipoOperacaoId) || null;
      if (!tipoOperacaoId) {
        return res.status(400).json({ success: false, error: 'Escolha a natureza de operação do PDV' });
      }
      const tipo = db.prepare('SELECT * FROM tipos_operacao WHERE id = ? AND ativo = 1').get(tipoOperacaoId);
      if (!tipo) return res.status(400).json({ success: false, error: 'Natureza de operação inválida ou inativa' });
      if (!Number(tipo.emiteNFe)) {
        return res.status(400).json({ success: false,
          error: `A natureza "${tipo.descricao}" não emite documento fiscal — o PDV só emite NFC-e` });
      }

      const politicaId = Number(b.pdvPoliticaPrazoId) || null;
      if (politicaId) {
        const pol = db.prepare('SELECT id, aplicaPdv FROM politicas_prazo WHERE id = ? AND ativo = 1').get(politicaId);
        if (!pol) return res.status(400).json({ success: false, error: 'Política de prazo inválida ou inativa' });
        if (!Number(pol.aplicaPdv)) {
          return res.status(400).json({ success: false,
            error: 'Essa política não está marcada para o PDV (aplicaPdv) — ajuste em Financeiro › Políticas de prazo' });
        }
      }

      const modosImpressao = new Set(['nenhum', 'termico-58', 'termico-80', 'a4', 'email']);
      const modoImp = String(b.pdvModoImpressao || 'nenhum');
      const modoImpValido = modosImpressao.has(modoImp) ? modoImp : 'nenhum';

      db.prepare(`UPDATE nfce_config SET
        pdvTipoOperacaoId = ?,
        pdvPoliticaPrazoId = ?,
        pdvExigirCpfSempre = ?,
        pdvModoImpressao = ?,
        dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = 1`)
      .run(
        tipoOperacaoId,
        politicaId,
        b.pdvExigirCpfSempre ? 1 : 0,
        modoImpValido,
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Fechamento da venda de balcão. O PDV emite só NFC-e (modelo 65): o ramo
  // NFe 55 — que criava pedido + fatura e transmitia mod 55 quando a venda
  // fugia do perfil de varejo — saiu em 2026-08-26. Venda que não cabe em NFC-e
  // (PJ, interestadual, alto valor) passa a ser feita pela NF avulsa em Fiscal.
  app.post('/api/pdv/finalizar', async (req, res) => {
    try {
      const payload = req.body || {};
      // Multi-loja: carimba o estabelecimento ativo da sessão no PDV (NULL = matriz).
      const _e = getEstabelecimentoAtivo(db, req);
      if (_e && !_e.matriz) payload.estabelecimentoId = _e.id;
      const { lerEmail, contatoDoBalcao } = require('./contato-marketing');
      const email = lerEmail(payload.consumidorEmail);
      if (email === false) return res.status(400).json({ success: false, error: 'E-mail do consumidor inválido' });
      const r = await emitirNFCe(db, payload);
      // Contato para promoções: só com a nota autorizada, e sem mexer em quem
      // é o destinatário nem em quem recebe a conta a receber.
      if (r && (r.cStat === '100' || r.cStat === '150')) {
        try {
          contatoDoBalcao(db, { cpfCnpj: payload.consumidorCpfCnpj, nome: payload.consumidorNome,
                                email, aceite: !!payload.aceitePromocoes });
        } catch (e) { console.error('[pdv/finalizar] contato de marketing:', e.message); }
      }
      res.json({ success: true, modelo: '65', ...r });
    } catch (err) {
      console.error('[pdv/finalizar]', err);
      res.status(400).json({ success: false, error: String(err.message || err) });
    }
  });

  app.get('/api/nfce', (req, res) => {
    try {
      const { status, busca, limit } = req.query;
      let sql = `SELECT id, numero, serie, chaveAcesso, dataEmissao, valorTotal, consumidorCpfCnpj, consumidorNome, qrCodeUrl, statusSefaz, rejeicaoMotivo FROM nfce WHERE 1=1`;
      const p = [];
      if (status) { sql += ' AND statusSefaz = ?'; p.push(status); }
      if (busca) { sql += ' AND (consumidorNome LIKE ? OR consumidorCpfCnpj LIKE ? OR chaveAcesso LIKE ?)'; const t = '%' + busca + '%'; p.push(t, t, t); }
      sql += ' ORDER BY dataEmissao DESC LIMIT ?'; p.push(Number(limit) || 100);
      const items = db.prepare(sql).all(...p);
      res.json({ success: true, items });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/nfce/:id', (req, res) => {
    try {
      const n = db.prepare('SELECT * FROM nfce WHERE id = ?').get(req.params.id);
      if (!n) return res.status(404).json({ success: false, error: 'NFC-e não encontrada' });
      const itens = db.prepare('SELECT * FROM nfce_itens WHERE nfceId = ? ORDER BY id ASC').all(req.params.id);
      const pagamentos = db.prepare('SELECT * FROM nfce_pagamentos WHERE nfceId = ? ORDER BY id ASC').all(req.params.id);
      res.json({ success: true, nfce: n, itens, pagamentos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/nfce/:id/xml', (req, res) => {
    try {
      const n = db.prepare('SELECT chaveAcesso, xmlAssinado FROM nfce WHERE id = ?').get(req.params.id);
      if (!n || !n.xmlAssinado) return res.status(404).json({ success: false, error: 'XML não disponível' });
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="${n.chaveAcesso || 'nfce'}.xml"`);
      res.send(n.xmlAssinado);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/nfce/:id/cancelar', async (req, res) => {
    try {
      const motivo = (req.body?.motivo || '').trim();
      if (motivo.length < 15) return res.status(400).json({ success: false, error: 'Motivo deve ter pelo menos 15 caracteres' });
      const n = db.prepare('SELECT * FROM nfce WHERE id = ?').get(req.params.id);
      if (!n) return res.status(404).json({ success: false, error: 'NFC-e não encontrada' });
      if (n.statusSefaz !== 'autorizada') return res.status(400).json({ success: false, error: 'NFC-e não está autorizada' });

      const tools = await getTools(db);
      const resp = await tools.sefazEvento({
        chNFe: n.chaveAcesso,
        tpEvento: '110111',
        nSeqEvento: 1,
        xJust: motivo,
        nProt: n.protocoloAutorizacao
      });
      const str = typeof resp === 'string' ? resp : JSON.stringify(resp);
      const retEv = (str.match(/<retEvento[^>]*>([\s\S]*?)<\/retEvento>/) || [])[1] || '';
      const cStat = tag(retEv, 'cStat') || tag(str, 'cStat');
      const xMotivo = tag(retEv, 'xMotivo') || tag(str, 'xMotivo');
      const nProt = tag(retEv, 'nProt');

      if (cStat === '135' || cStat === '155') {
        db.prepare(`UPDATE nfce SET statusSefaz='cancelada', motivoCancelamento=?, dataCancelamento=CURRENT_TIMESTAMP, dataAtualizacao=CURRENT_TIMESTAMP WHERE id = ?`)
          .run(`${motivo} (protocolo ${nProt || '—'})`, req.params.id);
        res.json({ success: true, cStat, xMotivo, nProt });
      } else {
        res.status(400).json({ success: false, cStat, xMotivo, raw: str.slice(0, 2000) });
      }
    } catch (err) { res.status(500).json({ success: false, error: String(err.message || err) }); }
  });

  console.log('[nfce] Rotas registradas');
}

module.exports = {
  registrarRotasNFCe: registrarRotas,
  // A emissão em si, para quem monta o payload fora daqui. O restaurante usa
  // no fechamento de comanda: a conversa com a SEFAZ é deste módulo, e quem
  // chama entrega só o payload. Devolve o mesmo objeto de /api/nfce/emitir,
  // em que o id da nota é `id`.
  emitirNFCe,
  // Expostos para teste: são a parte da emissão que não depende de SEFAZ.
  naturezaDoPdv, politicaDoPdv, parcelasDaPolitica, aplicarEfeitosDaNatureza,
  // A fronteira reutilizável (2026-09-21). Os três campos OPCIONAIS do payload:
  //
  //   tipoOperacaoId      natureza desta nota; omitido = a do PDV
  //   efeitosJaAplicados  true = só documenta, não mexe em estoque nem em CR
  //   pedidoId            pedido comercial de origem; gravado em nfce.pedidoId
  //
  // Omitir os três é o caminho de sempre, e é o que PDV e restaurante fazem.
  naturezaDaEmissao, pedidoDaEmissao,
};
