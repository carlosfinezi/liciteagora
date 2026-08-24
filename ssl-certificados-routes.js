/**
 * ssl-certificados-routes.js — Integração NicSRS: compra e ciclo de vida de
 * certificados SSL amarrados a contratos de cliente.
 *
 * Por que o módulo existe: desde 03/2026 o teto de validade de um certificado
 * público é ~200 dias (199 na DigiCert), mas os contratos da 1bit são de 12
 * meses ou mais. Comprar "1 year" na NicSRS não entrega um arquivo de 1 ano —
 * entrega uma ASSINATURA de 1 ano na CA, dentro da qual é preciso reemitir
 * (`/ssl/reissue`, gratuito) a cada ~200 dias. Quem gira esse relógio é o
 * ssl-certificados-scheduler.js; aqui ficam o cadastro e as ações manuais.
 *
 * Modelo:
 *   ssl_certificados         — um por domínio contratado (todo o ciclo de vida)
 *   ssl_certificados_eventos — histórico (compra, emissão, reissue, alerta...)
 *   ssl_produtos_nicsrs      — cache do /ssl/productList (código + preço + limites)
 *
 * Status local:
 *   rascunho              cadastro incompleto (sem CSR ou sem produto)
 *   aguardando-aprovacao  pronto para comprar — NADA foi gasto ainda
 *   comprado              /ssl/place aceito; CA ainda validando (PENDING)
 *   emitido               certificado disponível (COMPLETE)
 *   reemitindo            reissue disparado, aguardando o novo material
 *   cancelado             cancelado/revogado na NicSRS
 *   expirado              a assinatura (cobertoAte) terminou
 *
 * A compra é o único ponto que gasta dinheiro real e por decisão de projeto
 * NUNCA é automática: exige POST explícito em /aprovar.
 */

const { execFile } = require('child_process');
const nicsrs = require('./nicsrs-client');
const { logAction } = require('./audit-log');
const { enviarEmailSimples } = require('./email-client');

// `em-validacao`: dados já submetidos à CA, esperando DCV (aprovação do
// domínio) e OV (validação da organização). Não é `reemitindo`, que é o ciclo
// de renovação do arquivo dentro de uma assinatura já emitida.
const STATUS = ['rascunho', 'aguardando-aprovacao', 'aguardando-dados', 'comprado',
                'em-validacao', 'emitido', 'reemitindo', 'substituido', 'cancelado', 'expirado'];
const DCV_METODOS = ['EMAIL', 'HTTP_CSR_HASH', 'CNAME_CSR_HASH', 'HTTPS_CSR_HASH'];

// Antecedência padrão do reissue: 15 dias antes do arquivo atual expirar.
const REISSUE_ANTECEDENCIA_PADRAO = 15;

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ssl_certificados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contratoId INTEGER,
      clienteId INTEGER,
      produtoId INTEGER,
      productCode TEXT NOT NULL,
      productName TEXT,
      vendor TEXT,
      commonName TEXT NOT NULL,
      dominiosSan TEXT,
      anos INTEGER NOT NULL DEFAULT 1,
      csr TEXT,
      servidor TEXT DEFAULT 'NGINX',
      dcvMethod TEXT NOT NULL DEFAULT 'CNAME_CSR_HASH',
      dcvEmail TEXT,
      uniqueValue TEXT,
      refId TEXT UNIQUE,
      orderNum TEXT,
      certId TEXT,
      vendorCertId TEXT,
      statusNicsrs TEXT,
      status TEXT NOT NULL DEFAULT 'rascunho',
      beginDate TEXT,
      endDate TEXT,
      cobertoAte TEXT,
      proximoReissueEm TEXT,
      reissuesFeitos INTEGER NOT NULL DEFAULT 0,
      certificado TEXT,
      caCertificate TEXT,
      dcvDetalhe TEXT,
      custoUsd REAL,
      custoBrl REAL,
      contaPagarId INTEGER,
      dataCompra TEXT,
      ultimoErro TEXT,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contratoId) REFERENCES contratos(id),
      FOREIGN KEY (clienteId) REFERENCES pessoas(id),
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ssl_cert_contrato ON ssl_certificados(contratoId);
    CREATE INDEX IF NOT EXISTS idx_ssl_cert_status ON ssl_certificados(status, endDate);
    CREATE INDEX IF NOT EXISTS idx_ssl_cert_certid ON ssl_certificados(certId);

    CREATE TABLE IF NOT EXISTS ssl_certificados_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      certificadoId INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      descricao TEXT,
      payload TEXT,
      usuario TEXT,
      FOREIGN KEY (certificadoId) REFERENCES ssl_certificados(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ssl_eventos_cert ON ssl_certificados_eventos(certificadoId, data);

    -- O PEDIDO na NicSRS, entre o pedido de compra e o certificado.
    --
    -- Comprar adquire uma ASSINATURA; o certificado só existe quando os dados
    -- (domínio, CSR, DCV) são submetidos. E um pedido pode render vários
    -- certificados: nesta conta, o RC17709960705875 rendeu 5 e o
    -- RC17823149695875 rendeu 2. Tratar orderNum como campo do certificado
    -- assumia 1-para-1 e obrigava a inventar certificado para pedido sem
    -- domínio ainda.
    CREATE TABLE IF NOT EXISTS ssl_pedidos_nicsrs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orderNum TEXT UNIQUE,
      certIdAssinatura TEXT,
      pedidoCompraId INTEGER,
      contratoItemId INTEGER,
      productCode TEXT NOT NULL,
      productName TEXT,
      vendor TEXT,
      anos INTEGER NOT NULL DEFAULT 1,
      valorUsd REAL,
      valorBrl REAL,
      contaPagarId INTEGER,
      status TEXT NOT NULL DEFAULT 'aguardando-dados',
      beginDate TEXT,
      cobertoAte TEXT,
      refId TEXT UNIQUE,
      dataCompra TEXT,
      ultimoErro TEXT,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pedidoCompraId) REFERENCES pedidos_compra(id),
      FOREIGN KEY (contratoItemId) REFERENCES contratos_itens(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ssl_pedidos_compra ON ssl_pedidos_nicsrs(pedidoCompraId);
    CREATE INDEX IF NOT EXISTS idx_ssl_pedidos_status ON ssl_pedidos_nicsrs(status, cobertoAte);

    CREATE TABLE IF NOT EXISTS ssl_produtos_nicsrs (
      code TEXT PRIMARY KEY,
      vendor TEXT,
      productName TEXT,
      validationType TEXT,
      supportWildcard TEXT,
      supportSan TEXT,
      maxDomain INTEGER,
      maxYear INTEGER,
      basePrice TEXT,
      sanPrice TEXT,
      produtoId INTEGER,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Coluna acrescentada depois da primeira versão da tabela: bases criadas
  // antes disto precisam do ALTER. `refId` é NOSSO id de compra (único);
  // `orderNum` é o pedido da NicSRS, que se repete quando um pedido cobre
  // vários certificados.
  try {
    db.exec('ALTER TABLE ssl_certificados ADD COLUMN orderNum TEXT');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  // Qual linha do contrato este certificado cumpre. Com 8 certificados no
  // mesmo contrato, só o contratoId não diz qual item cada um atende.
  try {
    db.exec('ALTER TABLE ssl_certificados ADD COLUMN contratoItemId INTEGER');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  // Pedido de compra que originou a aquisição. A compra na NicSRS deixa de ser
  // disparada direto da tela do certificado e passa pelo fluxo de Compras:
  // rascunho -> enviar (com alçada) -> compra real.
  try {
    db.exec('ALTER TABLE ssl_certificados ADD COLUMN pedidoCompraId INTEGER');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  // De qual pedido NicSRS este certificado saiu. Substitui o uso de
  // `orderNum` na própria linha do certificado, que assumia 1 pedido =
  // 1 certificado. A coluna orderNum continua existindo por compatibilidade,
  // mas não deve ser lida em código novo — a verdade está em
  // ssl_pedidos_nicsrs.
  try {
    db.exec('ALTER TABLE ssl_certificados ADD COLUMN pedidoNicsrsId INTEGER');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  // Contatos exigidos pela CA na emissão (JSON por papel). A NicSRS pede os
  // três separadamente; até aqui mandávamos o mesmo contato do tenant nos três,
  // o que funciona mas não é o que a CA espera nem o que o cliente informa.
  //
  // A ORGANIZAÇÃO não fica aqui: num certificado OV/EV quem a CA valida é o
  // dono do domínio, ou seja o cliente do contrato — ela é montada a partir do
  // cadastro dele na hora de emitir (ver organizacaoDoCliente).
  for (const col of ['contatoAdmin', 'contatoFinanceiro', 'contatoTecnico']) {
    try {
      db.exec(`ALTER TABLE ssl_certificados ADD COLUMN ${col} TEXT`);
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }

  // O histórico importado NÃO é migrado para ssl_pedidos_nicsrs (decisão de
  // 2026-08-21). Aquelas 33 compras antigas seguem com o orderNum na própria
  // linha do certificado; a tabela nova serve ao fluxo daqui para a frente,
  // que nasce do pedido de compra. Misturar os dois só produziria dado
  // reconstruído a partir de suposição.
}

// ==================== config do tenant ====================

function getConfig(db, chave, padrao = null) {
  const row = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
  return row && row.valor != null ? row.valor : padrao;
}

function setConfig(db, chave, valor) {
  db.prepare(`
    INSERT INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, dataAtualizacao = CURRENT_TIMESTAMP
  `).run(chave, valor == null ? null : String(valor));
}

function getToken(db) {
  const t = getConfig(db, 'nicsrs_api_token');
  if (!t) throw new Error('Token da NicSRS não configurado (Configurações → Integração NicSRS)');
  return t;
}

// ==================== helpers ====================

function registrarEvento(db, certificadoId, tipo, descricao, payload, usuario) {
  db.prepare(`
    INSERT INTO ssl_certificados_eventos (certificadoId, tipo, descricao, payload, usuario)
    VALUES (?, ?, ?, ?, ?)
  `).run(certificadoId, tipo, descricao || null, payload ? JSON.stringify(payload) : null, usuario || null);
}

function addDias(dataIso, dias) {
  if (!dataIso) return null;
  const d = new Date(`${String(dataIso).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function hojeIso() {
  return new Date().toISOString().slice(0, 10);
}

/** refId idempotente: a NicSRS usa para não duplicar pedido em caso de retry. */
function gerarRefId(db, id) {
  return `LA-${id}-${Date.now().toString(36)}`;
}

function antecedenciaReissue(db) {
  const n = Number(getConfig(db, 'nicsrs_reissue_antecedencia_dias', REISSUE_ANTECEDENCIA_PADRAO));
  return Number.isFinite(n) && n > 0 ? n : REISSUE_ANTECEDENCIA_PADRAO;
}

/**
 * Aplica no banco o resultado de um /ssl/collect. Centralizado aqui porque
 * tanto as rotas quanto o scheduler precisam da mesma regra — inclusive o
 * cálculo de `cobertoAte`, que é o que sustenta o ciclo de reissue.
 */
function aplicarCollect(db, cert, resposta) {
  const d = resposta.data || {};
  const statusNicsrs = resposta.status || d.status || null;
  const beginDate = d.beginDate ? String(d.beginDate).slice(0, 10) : cert.beginDate;
  // endDate aqui é o do ARQUIVO (~200 dias). O fim da assinatura vem em
  // dueDate — conferido na conta 1bit: um certificado de 01/08/2026 traz
  // endDate 2027-02-16 e dueDate 2027-08-01.
  const endDate = d.endDate ? String(d.endDate).slice(0, 10) : cert.endDate;

  // A assinatura vale `anos` a partir do primeiro certificado emitido e não é
  // estendida por reissue. Preferimos o dueDate da NicSRS; só calculamos
  // quando ela não informa.
  let cobertoAte = cert.cobertoAte;
  if (d.dueDate) cobertoAte = String(d.dueDate).slice(0, 10);
  else if (!cobertoAte && beginDate) cobertoAte = addDias(beginDate, 365 * (cert.anos || 1));

  let status = cert.status;
  if (statusNicsrs === 'COMPLETE') status = 'emitido';
  else if (statusNicsrs === 'CANCELLED') status = 'cancelado';
  // REISSUED marca o registro ANTIGO, já trocado por um novo certId. Não é
  // erro nem cancelamento: é histórico, e não deve entrar na fila de reissue.
  else if (statusNicsrs === 'REISSUED') status = 'substituido';
  // 'aguardando-dados' é mais específico que 'comprado' e a coleta não sabe
  // disso — sem esta exceção, o collect logo após a importação rebaixava o
  // pedido recém-comprado para 'comprado' e escondia que faltam dados.
  else if (statusNicsrs === 'PENDING' && !['reemitindo', 'aguardando-dados'].includes(cert.status)) status = 'comprado';

  const proximoReissueEm = (status === 'emitido' && endDate && cobertoAte && endDate < cobertoAte)
    ? addDias(endDate, -antecedenciaReissue(db))
    : null;

  db.prepare(`
    UPDATE ssl_certificados SET
      statusNicsrs = ?, status = ?, beginDate = ?, endDate = ?, cobertoAte = ?,
      proximoReissueEm = ?, certificado = COALESCE(?, certificado),
      caCertificate = COALESCE(?, caCertificate), vendorCertId = COALESCE(?, vendorCertId),
      dcvDetalhe = COALESCE(?, dcvDetalhe), ultimoErro = NULL,
      dataAtualizacao = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    statusNicsrs, status, beginDate || null, endDate || null, cobertoAte || null,
    proximoReissueEm, d.certificate || null, d.caCertificate || null,
    d.vendorCertId != null ? String(d.vendorCertId) : null,
    d.dcvList ? JSON.stringify(d.dcvList) : null,
    cert.id
  );

  return { statusNicsrs, status, beginDate, endDate, cobertoAte, proximoReissueEm };
}

// Vendors aceitos pela API, conferidos em 2026-08-20 contra a conta 1bit.
// A grafia importa: 'Digicert' passa, 'DigiCert' e 'digicert' devolvem
// "vendor invalid". GeoTrust e Actalis não são vendors — RapidSSL, por
// exemplo, vem dentro de Digicert.
const VENDORS = ['Sectigo', 'Certum', 'Thawte', 'sslTrus', 'Digicert'];

/**
 * Puxa o catálogo de cada vendor e atualiza `ssl_produtos_nicsrs`. Fora do
 * handler porque script de manutenção precisa da mesma rotina.
 */
async function sincronizarProdutos(db, apiToken, vendors) {
  const alvos = Array.isArray(vendors) && vendors.length ? vendors : VENDORS;
  const ins = db.prepare(`
    INSERT INTO ssl_produtos_nicsrs
      (code, vendor, productName, validationType, supportWildcard, supportSan, maxDomain, maxYear, basePrice, sanPrice, dataAtualizacao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(code) DO UPDATE SET
      vendor = excluded.vendor, productName = excluded.productName,
      validationType = excluded.validationType, supportWildcard = excluded.supportWildcard,
      supportSan = excluded.supportSan, maxDomain = excluded.maxDomain,
      maxYear = excluded.maxYear, basePrice = excluded.basePrice,
      sanPrice = excluded.sanPrice, dataAtualizacao = CURRENT_TIMESTAMP
  `);
  const resultado = [];
  for (const vendor of alvos) {
    try {
      const r = await nicsrs.productList(apiToken, vendor);
      const lista = Array.isArray(r.data) ? r.data : [];
      db.transaction(() => {
        for (const p of lista) {
          // A API entrega os preços aninhados em `price`, não na raiz do
          // produto como a documentação sugere. sanPrice ainda se abre em
          // { wildPrice, normalPrice }.
          const preco = p.price || {};
          ins.run(
            String(p.code), vendor, p.productName || null, p.validationType || null,
            p.supportWildcard != null ? String(p.supportWildcard) : null,
            p.supportSan != null ? String(p.supportSan) : null,
            p.maxDomain != null ? Number(p.maxDomain) : null,
            p.maxYear != null ? Number(p.maxYear) : null,
            preco.basePrice ? JSON.stringify(preco.basePrice) : null,
            preco.sanPrice ? JSON.stringify(preco.sanPrice) : null
          );
        }
      })();
      resultado.push({ vendor, produtos: lista.length });
    } catch (err) {
      resultado.push({ vendor, erro: err.message });
    }
  }
  return resultado;
}

// ==================== preços dos produtos do catálogo ====================

function normalizarNome(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Repassa os preços da NicSRS para o catálogo de `produtos` do tenant.
 *
 * Os 75 SKUs SSL-NICSRS-* foram criados em 2026-05 com preços coletados do
 * site e uma cotação fixa. Aqui o custo passa a vir da API (price012, preço de
 * 12 meses) convertido pela PTAX do dia.
 *
 * O casamento é por nome normalizado e fica gravado em
 * ssl_produtos_nicsrs.produtoId, então só precisa acertar uma vez.
 *
 * Preço de venda: recalculado apenas onde há `markupVenda` cadastrado —
 * senão o produto ficaria com custo novo e venda velha, corroendo a margem em
 * silêncio. Sem markup, não se mexe.
 */
/**
 * Cria no catálogo os produtos que a API oferece e o tenant ainda não tem.
 *
 * O import de 2026-05 foi montado da lista do site, que não trazia a Certum —
 * e a Certum é justamente a CA de boa parte dos certificados em uso. Sem estes
 * produtos não há o que vincular a um item de contrato.
 *
 * Segue o padrão do scripts/import-nicsrs-ssl-1bit.js: SKU SSL-NICSRS-NNN,
 * categoria "Certificado SSL", tipo SERVICO, fornecedor NICSRS.
 */
function criarProdutosFaltantes(db, cotacao, faltantes) {
  const fornecedorId = resolverFornecedorNicsrs(db);
  const ultimo = db.prepare(
    `SELECT sku FROM produtos WHERE sku LIKE 'SSL-NICSRS-%' ORDER BY sku DESC LIMIT 1`
  ).get();
  let proximo = ultimo ? Number(String(ultimo.sku).replace(/\D/g, '')) + 1 : 1;

  const ins = db.prepare(`
    INSERT INTO produtos
      (sku, descricao, unidade, precoCusto, precoVenda, markupVenda, categoria, marca,
       tipoProduto, fornecedorId, observacoes, ativo)
    VALUES (?, ?, 'UN', ?, ?, 100, 'Certificado SSL', ?, 'SERVICO', ?, ?, 1)
  `);
  const vincula = db.prepare('UPDATE ssl_produtos_nicsrs SET produtoId = ? WHERE code = ?');
  const criados = [];

  db.transaction(() => {
    for (const f of faltantes) {
      const detalhe = db.prepare('SELECT * FROM ssl_produtos_nicsrs WHERE code = ?').get(f.code);
      if (!detalhe) continue;
      const custo = Number((f.usd * cotacao.valor).toFixed(2));
      const sku = `SSL-NICSRS-${String(proximo++).padStart(3, '0')}`;
      const obs = [
        'Fornecedor: NICSRS (revenda internacional)',
        `Código NicSRS: ${detalhe.code}`,
        `Tipo de validação: ${(detalhe.validationType || '').toUpperCase() || '—'}`,
        `Wildcard: ${detalhe.supportWildcard === 'Y' ? 'Sim' : 'Não'}`,
        `Multi-domínio (SAN): ${detalhe.supportSan === 'Y' ? 'Sim' : 'Não'}`,
        `Domínios máximos: ${detalhe.maxDomain != null ? detalhe.maxDomain : '—'}`,
        `Assinatura máxima: ${detalhe.maxYear != null ? detalhe.maxYear + ' ano(s)' : '—'}`,
        `Preço NICSRS: USD ${f.usd.toFixed(2)} · cotação ${cotacao.fonte} de ${cotacao.data}: R$ ${cotacao.valor}`,
        'Criado a partir do catálogo da API NicSRS.',
      ].join('\n');
      const r = ins.run(sku, detalhe.productName, custo, Number((custo * 2).toFixed(2)),
                        detalhe.vendor || null, fornecedorId, obs);
      vincula.run(r.lastInsertRowid, detalhe.code);
      criados.push({ sku, descricao: detalhe.productName, vendor: detalhe.vendor, usd: f.usd, custoBrl: custo });
    }
  })();
  return criados;
}

function atualizarPrecosProdutos(db, cotacao, { recalcularVenda = true } = {}) {
  if (!cotacao || !cotacao.valor) {
    throw new Error(`sem cotação do dólar (${(cotacao && cotacao.erro) || 'indisponível'})`);
  }
  const catalogo = db.prepare('SELECT code, productName, vendor, basePrice, produtoId FROM ssl_produtos_nicsrs').all();
  const locais = db.prepare(`SELECT id, sku, descricao, markupVenda FROM produtos WHERE sku LIKE 'SSL-NICSRS-%'`).all();
  const porNome = new Map(locais.map(p => [normalizarNome(p.descricao), p]));

  const vincula = db.prepare('UPDATE ssl_produtos_nicsrs SET produtoId = ? WHERE code = ?');
  const atualizaCusto = db.prepare('UPDATE produtos SET precoCusto = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?');
  const atualizaAmbos = db.prepare('UPDATE produtos SET precoCusto = ?, precoVenda = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?');

  const resumo = { cotacao: cotacao.valor, cotacaoData: cotacao.data, atualizados: 0, vendaRecalculada: 0, semPreco: 0, semProdutoLocal: [], alteracoes: [] };

  db.transaction(() => {
    for (const item of catalogo) {
      const precos = item.basePrice ? JSON.parse(item.basePrice) : null;
      const usd = precos && precos.price012 != null ? Number(precos.price012) : null;
      if (usd == null) { resumo.semPreco++; continue; }

      const local = item.produtoId
        ? locais.find(p => p.id === item.produtoId)
        : porNome.get(normalizarNome(item.productName));
      if (!local) { resumo.semProdutoLocal.push({ code: item.code, vendor: item.vendor, productName: item.productName, usd }); continue; }

      if (item.produtoId !== local.id) vincula.run(local.id, item.code);

      const custo = Number((usd * cotacao.valor).toFixed(2));
      const markup = Number(local.markupVenda);
      if (recalcularVenda && Number.isFinite(markup) && markup > 0) {
        atualizaAmbos.run(custo, Number((custo * (1 + markup / 100)).toFixed(2)), local.id);
        resumo.vendaRecalculada++;
      } else {
        atualizaCusto.run(custo, local.id);
      }
      resumo.atualizados++;
      resumo.alteracoes.push({ sku: local.sku, produto: local.descricao, usd, custoBrl: custo });
    }
  })();

  // Produtos locais que a API não lista mais (ex.: GeoTrust/Actalis, que
  // deixaram de ser vendors). Ficam como estão — desativar é decisão do
  // usuário, não efeito colateral de uma atualização de preço.
  const casados = new Set(resumo.alteracoes.map(a => a.sku));
  resumo.semCorrespondenteNaApi = locais.filter(p => !casados.has(p.sku)).map(p => ({ sku: p.sku, descricao: p.descricao }));
  return resumo;
}

// ==================== importação do que já existe na NicSRS ====================

const STATUS_NICSRS_PARA_LOCAL = {
  COMPLETE: 'emitido',
  PENDING: 'comprado',
  REISSUED: 'substituido',
  CANCELLED: 'cancelado',
};

/**
 * Traz para o tenant os certificados que já existem na conta NicSRS.
 *
 * Sem isto o módulo nasce cego: a conta pode ter dezenas de certificados
 * vivos, comprados antes de o módulo existir, que são justamente os que
 * precisam do controle de reemissão.
 *
 * Duas fontes por certificado:
 *   /ssl/list    — cadastro e fim da ASSINATURA (campo endDate da listagem)
 *   /ssl/collect — fim do ARQUIVO, material emitido, DCV e o CSR original
 *
 * O collect só é chamado para quem está vivo (COMPLETE/PENDING): é uma
 * requisição por certificado, e cancelado/substituído não precisa.
 */
// ==================== ponte com o módulo de Compras ====================

/**
 * Cria um pedido de compra para um certificado que está aguardando aprovação.
 *
 * A partir daqui a aquisição segue o caminho normal de Compras: o pedido nasce
 * rascunho, passa pela alçada ao ser enviado e só então vira compra real na
 * NicSRS. É o que dá ao certificado o mesmo rastro de qualquer outra despesa.
 */
function gerarPedidoCompra(db, certificadoId, cotacao, usuario) {
  const cert = db.prepare('SELECT * FROM ssl_certificados WHERE id = ?').get(certificadoId);
  if (!cert) throw new Error('Certificado não encontrado');
  if (cert.pedidoCompraId) throw new Error(`Já existe o pedido de compra #${cert.pedidoCompraId} para este certificado`);
  if (cert.status !== 'aguardando-aprovacao') {
    throw new Error(`Só certificado aguardando aprovação vira pedido de compra (atual: ${cert.status})`);
  }
  const fornecedorId = resolverFornecedorNicsrs(db);
  if (!fornecedorId) throw new Error('Fornecedor NICSRS não cadastrado');

  // Produto do catálogo: preferimos o vínculo do código NicSRS, que é o que
  // carrega o custo atualizado pela PTAX.
  const doCatalogo = db.prepare('SELECT produtoId FROM ssl_produtos_nicsrs WHERE code = ?').get(cert.productCode);
  const produtoId = cert.produtoId || (doCatalogo && doCatalogo.produtoId) || null;
  if (!produtoId) throw new Error(`Produto ${cert.productCode} não está no catálogo — sincronize e crie os faltantes`);

  const custoUsd = Number(cert.custoUsd) || 0;
  const custoBrl = cotacao && cotacao.valor ? Number((custoUsd * cotacao.valor).toFixed(2)) : 0;

  const ano = new Date().getFullYear();
  const ultimo = db.prepare(`SELECT numero FROM pedidos_compra WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`).get(`PC-${ano}-%`);
  let seq = 1;
  if (ultimo) {
    const m = String(ultimo.numero).match(/-(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  const numero = `PC-${ano}-${String(seq).padStart(4, '0')}`;

  let pedidoId;
  db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO pedidos_compra
        (numero, fornecedorId, status, dataEmissao, valorTotal, observacoes, usuarioCriador)
      VALUES (?, ?, 'rascunho', ?, ?, ?, ?)
    `).run(numero, fornecedorId, hojeIso(), custoBrl,
           `Certificado SSL ${cert.commonName} · ${cert.productName || cert.productCode}`
           + (custoUsd ? ` · US$ ${custoUsd}` : '')
           + (cotacao && cotacao.valor ? ` · cotação ${cotacao.data}: R$ ${cotacao.valor}` : ''),
           usuario || null);
    pedidoId = r.lastInsertRowid;
    db.prepare(`
      INSERT INTO pedido_compra_itens (pedidoCompraId, produtoId, quantidade, custoUnitario, observacoes)
      VALUES (?, ?, 1, ?, ?)
    `).run(pedidoId, produtoId, custoBrl, `Domínio ${cert.commonName}`);
    db.prepare('UPDATE ssl_certificados SET pedidoCompraId = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
      .run(pedidoId, cert.id);
    registrarEvento(db, cert.id, 'pedido-compra', `Pedido de compra ${numero} gerado`, { pedidoId, numero, custoBrl }, usuario);
  })();

  return { pedidoCompraId: pedidoId, numero, custoBrl, custoUsd, produtoId };
}

/**
 * Compra na NicSRS as assinaturas de um pedido de compra.
 *
 * Uma assinatura por unidade da quantidade: item com quantidade 3 vira 3
 * pedidos NicSRS independentes, cada um com seu ciclo de reemissão. O
 * certificado (domínio, CSR, DCV) NÃO entra aqui — é etapa posterior.
 *
 * Cada assinatura leva um `refId` próprio, gravado antes da chamada: se a
 * resposta se perder, o retry reaproveita o mesmo refId e a NicSRS não cobra
 * duas vezes.
 *
 * Falha parcial é esperada e não é revertida — o que já foi comprado debitou
 * saldo de verdade. Os erros ficam registrados por assinatura.
 */
async function comprarAssinaturasDoPedido(db, pedido, itens, usuario, opcoes = {}) {
  // Token do canal tem precedência: permite um canal apontando para outra
  // conta NicSRS sem trocar o token do tenant inteiro.
  const token = opcoes.apiToken || getToken(db);
  const administrator = administradorPadrao(db);
  const cotacao = await obterCotacaoUsd(db);

  const compradas = [];
  const falhas = [];

  for (const item of itens) {
    const prod = db.prepare(
      'SELECT code, productName, vendor FROM ssl_produtos_nicsrs WHERE produtoId = ?'
    ).get(item.produtoId);
    if (!prod) continue;

    const unidades = Math.max(1, Math.round(Number(item.quantidade) || 1));
    for (let i = 0; i < unidades; i++) {
      const refId = `LA-PC${pedido.id}-I${item.id}-${i + 1}`;
      const anos = Number(item.anos) || 1;

      // Registra a intenção ANTES de chamar: assim uma falha de rede não deixa
      // compra órfã na NicSRS sem contrapartida aqui.
      let pedidoNicsrsId;
      try {
        const r = db.prepare(`
          INSERT INTO ssl_pedidos_nicsrs
            (pedidoCompraId, contratoItemId, productCode, productName, vendor, anos,
             valorUsd, valorBrl, status, refId, dataCompra, observacoes)
          VALUES (?,?,?,?,?,?,?,?,'comprando',?,?,?)
          ON CONFLICT(refId) DO NOTHING
        `).run(pedido.id, pedido.contratoItemId || null, prod.code, prod.productName, prod.vendor,
               anos, null, Number(item.custoUnitario) || null, refId, hojeIso(),
               `Pedido de compra ${pedido.numero} · unidade ${i + 1}/${unidades}`);
        pedidoNicsrsId = r.lastInsertRowid
          || db.prepare('SELECT id FROM ssl_pedidos_nicsrs WHERE refId = ?').get(refId).id;
      } catch (err) {
        falhas.push({ refId, erro: `não foi possível registrar a assinatura: ${err.message}` });
        continue;
      }

      // Já comprada num envio anterior: não repete.
      const atual = db.prepare('SELECT status, orderNum FROM ssl_pedidos_nicsrs WHERE id = ?').get(pedidoNicsrsId);
      if (atual && atual.orderNum) {
        compradas.push({ refId, orderNum: atual.orderNum, jaExistia: true });
        continue;
      }

      try {
        // A compra leva os dados do CERTIFICADO cadastrado para este item.
        //
        // A API de revenda NÃO tem submissão posterior: o /ssl/place compra e
        // configura na mesma chamada (comprovado em 2026-08-21 — place sem
        // dados devolve -1, e não existe endpoint de apply/submit). Por isso o
        // certificado precisa estar pronto ANTES de enviar o pedido.
        const cert = db.prepare(`
          SELECT * FROM ssl_certificados
          WHERE contratoItemId = ? AND status IN ('rascunho','aguardando-aprovacao','aguardando-dados')
          ORDER BY id LIMIT 1
        `).get(pedido.contratoItemId || -1);

        if (!cert) {
          throw new Error('nenhum certificado cadastrado para este item — cadastre em Certificados SSL '
            + '(com CSR, domínio e DCV) antes de enviar o pedido');
        }
        if (!cert.csr) throw new Error(`certificado #${cert.id} sem CSR — cole o CSR antes de enviar`);
        if (!cert.commonName) throw new Error(`certificado #${cert.id} sem domínio principal`);

        const params = montarParams(db, cert, administrator, null);
        const resposta = await nicsrs.place(token, { productCode: prod.code, years: anos, refId, params });
        const dados = resposta.data || {};
        const certIdAssinatura = dados.certId ? String(dados.certId) : null;
        const orderNum = dados.orderNum ? String(dados.orderNum) : null;

        db.prepare(`
          UPDATE ssl_pedidos_nicsrs SET
            orderNum = ?, certIdAssinatura = ?, status = 'aguardando-dados',
            valorUsd = COALESCE(valorUsd, ?),
            valorBrl = COALESCE(valorBrl, ?),
            ultimoErro = NULL, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(orderNum, certIdAssinatura,
               cotacao && cotacao.valor && item.custoUnitario ? Number((item.custoUnitario / cotacao.valor).toFixed(2)) : null,
               Number(item.custoUnitario) || null, pedidoNicsrsId);
        // O certificado deixa de ser cadastro solto: passa a apontar para a
        // assinatura que acabou de nascer, e entra em validação na CA.
        db.prepare(`
          UPDATE ssl_certificados
          SET pedidoNicsrsId = ?, certId = COALESCE(certId, ?), refId = COALESCE(refId, ?),
              status = 'em-validacao', dataCompra = ?, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(pedidoNicsrsId, certIdAssinatura, refId, hojeIso(), cert.id);

        compradas.push({ refId, orderNum, certIdAssinatura, pedidoNicsrsId, certificadoId: cert.id, dominio: cert.commonName });
      } catch (err) {
        db.prepare(`UPDATE ssl_pedidos_nicsrs SET status = 'erro', ultimoErro = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(err.message, pedidoNicsrsId);
        falhas.push({ refId, erro: err.message });
      }
    }
  }

  return {
    resumo: `${compradas.length} assinatura(s) comprada(s)` + (falhas.length ? `, ${falhas.length} com erro` : ''),
    compradas, falhas,
    parcial: compradas.length > 0 && falhas.length > 0,
    nenhuma: compradas.length === 0,
  };
}

/**
 * Executa na NicSRS as compras dos certificados de um pedido, e lança a
 * despesa. Chamada pelo módulo de Compras quando o pedido é ENVIADO — depois
 * de a alçada liberar, que é onde a autorização acontece.
 *
 * Devolve null quando o pedido não tem certificado nenhum, para o fluxo comum
 * de compras seguir intocado.
 */
async function comprarCertificadosDoPedido(db, pedidoCompraId, usuario) {
  const certificados = db.prepare(`
    SELECT * FROM ssl_certificados WHERE pedidoCompraId = ? AND status = 'aguardando-aprovacao'
  `).all(pedidoCompraId);
  if (!certificados.length) return null;

  const token = getToken(db);
  const administrator = administradorPadrao(db);
  const comprados = [];
  const falhas = [];

  for (const cert of certificados) {
    try {
      if (!cert.csr) throw new Error('CSR não informado');
      const refId = cert.refId || gerarRefId(db, cert.id);
      db.prepare('UPDATE ssl_certificados SET refId = ? WHERE id = ?').run(refId, cert.id);
      const params = montarParams(db, cert, administrator, null);
      const resposta = await nicsrs.place(token, {
        productCode: cert.productCode, years: cert.anos || 1, refId, params,
      });
      const certId = resposta.data && resposta.data.certId ? String(resposta.data.certId) : null;
      db.prepare(`
        UPDATE ssl_certificados SET
          certId = ?, status = 'comprado', statusNicsrs = 'PENDING', dataCompra = ?,
          ultimoErro = NULL, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(certId, hojeIso(), cert.id);
      registrarEvento(db, cert.id, 'compra', `Comprado na NicSRS pelo pedido #${pedidoCompraId} (certId ${certId})`,
        { certId, refId, pedidoCompraId }, usuario);
      comprados.push({ certificadoId: cert.id, commonName: cert.commonName, certId });
    } catch (err) {
      db.prepare('UPDATE ssl_certificados SET ultimoErro = ? WHERE id = ?').run(err.message, cert.id);
      registrarEvento(db, cert.id, 'erro-compra', err.message, null, usuario);
      falhas.push({ certificadoId: cert.id, commonName: cert.commonName, erro: err.message });
    }
  }
  return { comprados, falhas };
}

/**
 * Lança em contas a pagar as compras feitas na NicSRS que ainda não foram
 * lançadas — inclusive as feitas direto no painel, fora do módulo.
 *
 * Idempotente pelo número do pedido: a mesma compra não entra duas vezes, e
 * um pedido que cobre vários certificados é lançado uma vez só (a NicSRS
 * repete o orderNum em todos eles).
 */
function lancarComprasNoFinanceiro(db, cotacao, { apenasPedido = null } = {}) {
  const fornecedorId = resolverFornecedorNicsrs(db);
  if (!fornecedorId) return { lancados: 0, motivo: 'fornecedor NICSRS não cadastrado' };
  if (!cotacao || !cotacao.valor) {
    return { lancados: 0, motivo: `sem cotação do dólar (${(cotacao && cotacao.erro) || 'indisponível'})` };
  }

  // Uma linha por PEDIDO, não por certificado.
  // `apenasPedido` existe para não arrastar o histórico inteiro: a importação
  // traz anos de compras que provavelmente já foram lançadas pela fatura do
  // cartão, e lançar tudo de uma vez duplicaria despesa antiga.
  const pedidos = db.prepare(`
    SELECT orderNum,
           MIN(dataCompra) AS dataCompra,
           SUM(custoUsd)   AS totalUsd,
           COUNT(*)        AS certificados,
           GROUP_CONCAT(commonName, ', ') AS dominios
    FROM ssl_certificados
    WHERE orderNum IS NOT NULL AND custoUsd > 0 AND status <> 'cancelado'
      AND contaPagarId IS NULL
      AND (? IS NULL OR orderNum = ?)
    GROUP BY orderNum
  `).all(apenasPedido, apenasPedido);

  const jaLancado = db.prepare(
    `SELECT id FROM contas_a_pagar WHERE origem = 'ssl-nicsrs' AND observacoes LIKE ?`
  );
  const inserir = db.prepare(`
    INSERT INTO contas_a_pagar
      (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem, observacoes)
    VALUES (?, ?, ?, ?, ?, 'aberta', 'ssl-nicsrs', ?)
  `);
  const marcar = db.prepare('UPDATE ssl_certificados SET contaPagarId = ? WHERE orderNum = ?');

  let lancados = 0;
  const detalhe = [];
  db.transaction(() => {
    for (const p of pedidos) {
      const marca = `pedido ${p.orderNum}`;
      const existente = jaLancado.get(`%${marca}%`);
      if (existente) { marcar.run(existente.id, p.orderNum); continue; }

      const brl = Number((p.totalUsd * cotacao.valor).toFixed(2));
      const data = p.dataCompra || hojeIso();
      const r = inserir.run(
        fornecedorId,
        `SSL NicSRS — ${p.dominios}`.slice(0, 180),
        brl, data, data,
        `${marca} · US$ ${p.totalUsd} · ${p.certificados} certificado(s) · cotação ${cotacao.fonte} de ${cotacao.data}: R$ ${cotacao.valor}`
      );
      marcar.run(r.lastInsertRowid, p.orderNum);
      lancados++;
      detalhe.push({ pedido: p.orderNum, usd: p.totalUsd, brl, certificados: p.certificados });
    }
  })();
  return { lancados, detalhe, motivo: null };
}

async function importarDaNicsrs(db, apiToken, { comCollect = true } = {}) {
  const resposta = await nicsrs.chamar('ssl/list', apiToken, {});
  const lista = Array.isArray(resposta.data) ? resposta.data : [];

  const resumo = { encontrados: lista.length, criados: 0, atualizados: 0, detalhados: 0, erros: [] };
  const existente = db.prepare('SELECT * FROM ssl_certificados WHERE certId = ?');

  for (const c of lista) {
    const certId = String(c.certId);
    // Comprar na NicSRS paga a ASSINATURA; a solicitação do certificado é um
    // segundo passo. Entre os dois, o pedido existe pago e sem domínio, CSR ou
    // contatos — é o "Information to be Submitted" do painel. Sem status
    // próprio isso virava um 'comprado' com "(sem common name)", indistinguível
    // de um pedido em validação na CA.
    const faltamDados = c.status === 'PENDING' && !c.commonName;
    const statusLocal = faltamDados ? 'aguardando-dados' : (STATUS_NICSRS_PARA_LOCAL[c.status] || 'comprado');
    const sans = Array.isArray(c.domains) ? c.domains.filter(d => d && d !== c.commonName) : [];
    // period vem como "1year"/"2year"; o fim da assinatura é o endDate da listagem.
    const anos = Number(String(c.period || '').replace(/\D/g, '')) || 1;
    const cobertoAte = c.endDate ? String(c.endDate).slice(0, 10) : null;

    try {
      const atual = existente.get(certId);
      if (atual) {
        db.prepare(`
          UPDATE ssl_certificados SET
            statusNicsrs = ?, status = ?, cobertoAte = COALESCE(cobertoAte, ?),
            productName = COALESCE(productName, ?), vendor = COALESCE(vendor, ?),
            custoUsd = COALESCE(custoUsd, ?), orderNum = COALESCE(orderNum, ?),
            -- Quando os dados são submetidos, o domínio aparece: substitui o
            -- rótulo provisório "(a definir — pedido ...)".
            commonName = CASE WHEN ? <> '' AND (commonName LIKE '(a definir%' OR commonName = '(sem common name)')
                              THEN ? ELSE commonName END,
            dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(c.status, statusLocal, cobertoAte, c.productName || null, c.brand || null,
               c.amount != null ? Number(c.amount) : null,
               c.orderNum && c.orderNum !== 'undefined' ? String(c.orderNum) : null,
               c.commonName || '', c.commonName || '', atual.id);
        resumo.atualizados++;
      } else {
        db.prepare(`
          INSERT INTO ssl_certificados
            (productCode, productName, vendor, commonName, dominiosSan, anos, certId,
             statusNicsrs, status, beginDate, cobertoAte, custoUsd, dataCompra, orderNum, observacoes)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          c.productCode || 'desconhecido', c.productName || null, c.brand || null,
          // Sem domínio ainda, identifica pelo pedido — some assim que os
          // dados forem submetidos e a próxima importação trouxer o CN.
          c.commonName || `(a definir — pedido ${c.orderNum || certId})`,
          sans.length ? JSON.stringify(sans) : null,
          anos, certId, c.status, statusLocal,
          c.beginDate ? String(c.beginDate).slice(0, 10) : null,
          cobertoAte,
          c.amount != null ? Number(c.amount) : null,
          c.created ? String(c.created).slice(0, 10) : null,
          c.orderNum && c.orderNum !== 'undefined' ? String(c.orderNum) : null,
          'Importado da conta NicSRS'
        );
        resumo.criados++;
      }

      // Detalhe só de quem está vivo: é o que precisa de data de arquivo,
      // material e CSR para o reissue automático funcionar.
      if (comCollect && (c.status === 'COMPLETE' || c.status === 'PENDING')) {
        const cert = existente.get(certId);
        const det = await nicsrs.collect(apiToken, certId);
        aplicarCollect(db, cert, det);
        const csr = det.data && det.data.applyParams ? det.data.applyParams.csr : null;
        if (csr) db.prepare('UPDATE ssl_certificados SET csr = COALESCE(csr, ?) WHERE certId = ?').run(csr, certId);
        const dcv = det.data && Array.isArray(det.data.dcvList) ? det.data.dcvList[0] : null;
        if (dcv && dcv.dcvMethod) {
          db.prepare('UPDATE ssl_certificados SET dcvMethod = ?, dcvEmail = COALESCE(?, dcvEmail) WHERE certId = ?')
            .run(dcv.dcvMethod, dcv.dcvEmail || null, certId);
        }
        resumo.detalhados++;
      }
    } catch (err) {
      resumo.erros.push({ certId, commonName: c.commonName, erro: err.message });
    }
  }
  return resumo;
}

// ==================== e-mails aprovadores (DCV por e-mail) ====================

// Prefixos fixados pelo CA/Browser Forum — é a lista que toda CA aceita, e não
// há endpoint na NicSRS que a devolva (conferido nos 17 artigos da API).
const PREFIXOS_DCV = ['admin', 'administrator', 'hostmaster', 'postmaster', 'webmaster'];

// Sufixos de dois rótulos comuns no Brasil: sem eles, "crea-go.org.br" seria
// reduzido a "org.br", que não é domínio registrável.
const SUFIXOS_COMPOSTOS = [
  'com.br', 'org.br', 'gov.br', 'edu.br', 'net.br', 'jus.br', 'mp.br',
  'def.br', 'leg.br', 'art.br', 'ind.br', 'inf.br', 'rec.br', 'tur.br',
  'co.uk', 'com.ar', 'com.mx', 'com.co',
];

/**
 * Domínios candidatos a receber o e-mail de aprovação, do mais específico ao
 * domínio registrável. Wildcard é removido: a CA valida o domínio, não o "*".
 *
 * Para *.dev.sad.ancine.gov.br devolve sad.ancine.gov.br e ancine.gov.br —
 * qual deles a CA aceita varia, por isso a tela oferece as duas famílias em
 * vez de escolher sozinha.
 */
function dominiosParaDcv(commonName) {
  const limpo = String(commonName || '').trim().toLowerCase().replace(/^\*\./, '');
  if (!limpo || !limpo.includes('.')) return [];
  const partes = limpo.split('.');
  const composto = SUFIXOS_COMPOSTOS.find(s => limpo.endsWith('.' + s));
  const minimo = composto ? composto.split('.').length + 1 : 2;

  const saida = [];
  for (let i = 0; i <= partes.length - minimo; i++) {
    saida.push(partes.slice(i).join('.'));
  }
  return saida;
}

function emailsAprovadores(commonName) {
  const dominios = dominiosParaDcv(commonName);
  const saida = [];
  for (const d of dominios) {
    for (const p of PREFIXOS_DCV) saida.push(`${p}@${d}`);
  }
  return saida;
}

// ==================== leitura do CSR ====================

const CSR_MAX_BYTES = 16 * 1024;

/**
 * Lê o CSR com openssl e devolve o que dá para aproveitar do cadastro.
 *
 * O domínio já está DENTRO do CSR — redigitá-lo à mão só cria a chance de
 * divergir, e CSR com CN diferente do pedido é recusado pela CA depois de a
 * compra já ter sido paga.
 *
 * O CSR vai por stdin, nunca como argumento: é conteúdo colado pelo usuário.
 */
function inspecionarCSR(csr) {
  return new Promise((resolve, reject) => {
    const texto = String(csr || '').trim();
    if (!texto) return reject(new Error('CSR vazio'));
    if (Buffer.byteLength(texto) > CSR_MAX_BYTES) return reject(new Error('CSR muito grande'));
    if (!/-----BEGIN (NEW )?CERTIFICATE REQUEST-----/.test(texto)) {
      return reject(new Error('Não parece um CSR: falta a linha BEGIN CERTIFICATE REQUEST'));
    }

    const filho = execFile('openssl', ['req', '-noout', '-text'],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`CSR inválido: ${String(stderr || err.message).split('\n')[0]}`));

        const subject = {};
        const mSub = stdout.match(/Subject:\s*(.+)/);
        if (mSub) {
          for (const parte of mSub[1].split(',')) {
            const [k, ...v] = parte.split('=');
            if (k && v.length) subject[k.trim()] = v.join('=').trim();
          }
        }
        const commonName = subject.CN || null;

        // SAN aparece na linha seguinte ao cabeçalho da extensão.
        const sans = [];
        const mSan = stdout.match(/Subject Alternative Name:\s*\n\s*(.+)/);
        if (mSan) {
          for (const entrada of mSan[1].split(',')) {
            const t = entrada.trim();
            if (t.startsWith('DNS:')) sans.push(t.slice(4));
          }
        }
        const chave = (stdout.match(/Public-Key:\s*\((\d+) bit\)/) || [])[1];
        const algoritmo = (stdout.match(/Public Key Algorithm:\s*(.+)/) || [])[1];

        resolve({
          commonName,
          dominios: sans.filter(d => d && d !== commonName),
          subject,
          bits: chave ? Number(chave) : null,
          algoritmo: algoritmo ? algoritmo.trim() : null,
        });
      });
    filho.stdin.on('error', () => { /* openssl fechou antes: o callback já trata */ });
    filho.stdin.end(texto);
  });
}

// ==================== cotação do dólar ====================

const PTAX_URL = 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)';

function dataPtax(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}-${dd}-${d.getUTCFullYear()}`;
}

/**
 * Cotação do dia via PTAX do Banco Central. Usa a cotação de VENDA: é o que
 * se paga para comprar dólar, que é o caso aqui (pagamento ao exterior).
 *
 * A PTAX não publica em fim de semana nem feriado, então volta até 7 dias
 * atrás procurando o último pregão. O resultado fica em cache na `config` e
 * só é buscado de novo quando a data vira.
 */
async function obterCotacaoUsd(db, { forcar = false } = {}) {
  const hoje = hojeIso();
  const valorCache = Number(getConfig(db, 'nicsrs_cotacao_usd'));
  const dataCache = getConfig(db, 'nicsrs_cotacao_usd_data');
  const buscadoEm = getConfig(db, 'nicsrs_cotacao_usd_buscado_em');
  if (!forcar && buscadoEm === hoje && Number.isFinite(valorCache) && valorCache > 0) {
    return { valor: valorCache, data: dataCache, fonte: 'PTAX/BCB (cache do dia)' };
  }

  const hojeDate = new Date();
  for (let i = 0; i < 7; i++) {
    const alvo = new Date(hojeDate.getTime() - i * 86400000);
    const url = `${PTAX_URL}?@dataCotacao='${dataPtax(alvo)}'&$top=1&$format=json`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let json;
      try {
        const resp = await fetch(url, { signal: ctrl.signal });
        json = await resp.json();
      } finally {
        clearTimeout(timer);
      }
      const linha = json && Array.isArray(json.value) ? json.value[0] : null;
      if (linha && linha.cotacaoVenda) {
        const valor = Number(linha.cotacaoVenda);
        const data = String(linha.dataHoraCotacao || '').slice(0, 10);
        setConfig(db, 'nicsrs_cotacao_usd', valor);
        setConfig(db, 'nicsrs_cotacao_usd_data', data);
        setConfig(db, 'nicsrs_cotacao_usd_buscado_em', hoje);
        return { valor, data, fonte: 'PTAX/BCB' };
      }
    } catch (err) {
      // Rede fora ou BCB indisponível: tenta o dia anterior; se acabarem as
      // tentativas, cai no cache velho abaixo.
      console.error('[ssl] PTAX:', err.message);
    }
  }

  if (Number.isFinite(valorCache) && valorCache > 0) {
    return { valor: valorCache, data: dataCache, fonte: 'PTAX/BCB (desatualizada — BCB indisponível)', desatualizada: true };
  }
  return { valor: null, data: null, fonte: null, erro: 'não foi possível obter a cotação PTAX' };
}

/** Fornecedor NICSRS em `pessoas` (criado pelo scripts/import-nicsrs-ssl-1bit.js). */
function resolverFornecedorNicsrs(db) {
  const p = db.prepare(`SELECT id FROM pessoas WHERE razaoSocial = 'NICSRS' LIMIT 1`).get();
  return p ? p.id : null;
}

/**
 * Lança o custo da compra em contas a pagar. Silencioso quando não dá para
 * converter em BRL ou quando o fornecedor não existe — o certificado não pode
 * deixar de ser comprado por causa do financeiro.
 */
function lancarContaPagar(db, cert, custoUsd, custoBrlInformado, cotacao) {
  const fornecedorId = resolverFornecedorNicsrs(db);
  if (!fornecedorId) return { contaPagarId: null, custoBrl: custoBrlInformado || null, motivo: 'fornecedor NICSRS não cadastrado' };

  let custoBrl = custoBrlInformado != null ? Number(custoBrlInformado) : null;
  if (custoBrl == null && custoUsd != null && cotacao && cotacao.valor) {
    custoBrl = Number((custoUsd * cotacao.valor).toFixed(2));
  }
  if (custoBrl == null) {
    return { contaPagarId: null, custoBrl: null,
      motivo: cotacao && cotacao.erro ? `sem cotação do dólar (${cotacao.erro})` : 'sem custo em USD informado' };
  }

  const hoje = hojeIso();
  const memoria = [
    custoUsd != null ? `Custo NicSRS US$ ${custoUsd}` : null,
    cotacao && cotacao.valor ? `cotação ${cotacao.fonte} de ${cotacao.data}: R$ ${cotacao.valor}` : null,
  ].filter(Boolean).join(' · ');
  const r = db.prepare(`
    INSERT INTO contas_a_pagar
      (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem, observacoes)
    VALUES (?, ?, ?, ?, ?, 'aberta', 'ssl-nicsrs', ?)
  `).run(
    fornecedorId,
    `SSL ${cert.productName || cert.productCode} — ${cert.commonName}`,
    custoBrl, hoje, hoje, memoria || null
  );
  return { contaPagarId: r.lastInsertRowid, custoBrl, motivo: null };
}

// Códigos aceitos no campo `server` (apêndice "Server Platforms" da API).
// A plataforma decide o formato em que o certificado é entregue.
const SERVIDORES = [
  'apachessl', 'apache2', 'nginx', 'iis4', 'iis6', 'iis7', 'tomcat', 'plesk',
  'cpanel', 'domino', 'oracle', 'cisco', 'ibmhttp', 'javawebserv', 'other',
];

const ALIAS_SERVIDOR = {
  NGINX: 'nginx', APACHE: 'apache2', APACHE2: 'apache2', APACHESSL: 'apachessl',
  IIS: 'iis7', TOMCAT: 'tomcat', PLESK: 'plesk', CPANEL: 'cpanel', OTHER: 'other',
};

function normalizarServidor(valor) {
  const bruto = String(valor || '').trim();
  if (!bruto) return 'other';
  const minusculo = bruto.toLowerCase();
  if (SERVIDORES.includes(minusculo)) return minusculo;
  return ALIAS_SERVIDOR[bruto.toUpperCase()] || 'other';
}

/**
 * Converte o contato para o formato que a NicSRS realmente aceita.
 *
 * O campo da empresa chama-se `organation` — sem o "iz". É erro de digitação
 * da API deles, não daqui: consta assim no `applyParams` de todos os pedidos
 * pagos desta conta. Enviar `organization` (o nome da documentação) é ignorado
 * e o pedido vai sem o nome da organização.
 */
/**
 * Organização que a CA valida num certificado OV/EV: o DONO DO DOMÍNIO, isto é,
 * o cliente do contrato — não a 1bit. Montada do cadastro do cliente na hora de
 * emitir, para não guardar cópia que envelhece.
 */
function organizacaoDoCliente(db, clienteId) {
  if (!clienteId) return null;
  const p = db.prepare(`
    SELECT razaoSocial, cpfCnpj, endereco, numero, complemento, bairro,
           cidade, uf, cep, telefone
    FROM pessoas WHERE id = ?
  `).get(clienteId);
  if (!p) return null;

  const logradouro = [p.endereco, p.numero, p.complemento, p.bairro]
    .filter(Boolean).join(', ');
  return {
    organation: p.razaoSocial || '',      // grafia da NicSRS, ver paraContatoNicsrs
    address: logradouro,
    city: p.cidade || '',
    province: p.uf || '',
    country: 'BR',
    postCode: (p.cep || '').replace(/\D/g, ''),
    phone: (p.telefone || '').replace(/\D/g, ''),
    idNumber: (p.cpfCnpj || '').replace(/\D/g, ''),
  };
}

/** Contato gravado no certificado; cai no contato do tenant se não houver. */
function contatoDoCertificado(db, cert, papel) {
  const bruto = cert && cert[papel];
  if (bruto) {
    try {
      const c = JSON.parse(bruto);
      if (c && (c.email || c.firstName)) return paraContatoNicsrs(c);
    } catch (_) { /* JSON torto: usa o padrão */ }
  }
  return paraContatoNicsrs(administradorPadrao(db));
}

function paraContatoNicsrs(contato) {
  if (!contato || typeof contato !== 'object') return contato;
  const { organization, organation, ...resto } = contato;
  return { ...resto, organation: organation || organization || '' };
}

/** Monta o `params` do /ssl/place a partir do cadastro local + contato admin. */
function montarParams(db, cert, administrator, organizationInfo) {
  const sans = cert.dominiosSan ? JSON.parse(cert.dominiosSan) : [];
  const dominios = [cert.commonName, ...sans.filter(d => d && d !== cert.commonName)];
  const domainInfo = dominios.map(domainName => ({
    domainName,
    dcvMethod: cert.dcvMethod,
    ...(cert.dcvMethod === 'EMAIL' && cert.dcvEmail ? { dcvEmail: cert.dcvEmail } : {}),
  }));

  // O formato abaixo foi extraído de `applyParams` de compras REAIS desta
  // conta (via /ssl/collect) — é o que a NicSRS comprovadamente aceitou, e
  // difere da documentação em dois pontos.
  // Contatos informados no certificado; sem eles, o contato do tenant nos três
  // papéis (que é o que a conta sempre mandou e a NicSRS aceita).
  const padrao = paraContatoNicsrs(administrator);
  const admin = contatoDoCertificado(db, cert, 'contatoAdmin') || padrao;
  const params = {
    csr: cert.csr,
    // Códigos do apêndice "Server Platforms", em minúsculas: nginx, apache2,
    // iis7, other… "NGINX" não é aceito.
    server: normalizarServidor(cert.servidor),
    domainInfo,
    Administrator: admin,
    tech: contatoDoCertificado(db, cert, 'contatoTecnico') || admin,
    finance: contatoDoCertificado(db, cert, 'contatoFinanceiro') || admin,
  };

  // Organização validada pela CA num OV/EV: o cliente do contrato, dono do
  // domínio. Vai do cadastro dele, não de cópia guardada no certificado.
  const org = organizationInfo || organizacaoDoCliente(db, cert.clienteId);
  if (org && org.organation) Object.assign(params, org);
  if (cert.uniqueValue) params.uniqueValue = cert.uniqueValue;
  if (organizationInfo) params.organizationInfo = organizationInfo;
  return params;
}

/**
 * Contato administrativo do pedido. Vem de config (dados da própria 1bit, que
 * é quem revende) e pode ser sobrescrito por chamada.
 */
function administradorPadrao(db, override) {
  if (override && override.email) return override;
  const bruto = getConfig(db, 'nicsrs_administrator');
  if (!bruto) throw new Error('Contato administrativo da NicSRS não configurado (config nicsrs_administrator)');
  try {
    return JSON.parse(bruto);
  } catch {
    throw new Error('config nicsrs_administrator não é um JSON válido');
  }
}

function registrarRotasSslCertificados(app, db) {
  migrarDB(db);

  // Add-on por tenant: as tabelas existem em todos (o schema é único), então
  // sem este gate qualquer tenant chamaria /api/ssl/* sabendo o endereço — e
  // essas rotas gastam saldo e leem o token da NicSRS. O RBAC por página não
  // cobre isso: ele filtra o menu, não quem chama a API direto.
  app.use('/api/ssl', (req, res, next) => {
    try {
      const row = db.prepare("SELECT valor FROM config WHERE chave = 'ssl_enabled'").get();
      if (row && row.valor === '1') return next();
    } catch (_) { /* sem tabela config: trata como desligado */ }
    res.status(403).json({ success: false, error: 'Módulo de certificados SSL não contratado' });
  });

  // ==================== CONFIG ====================

  // Nunca devolve o token: só se ele existe e os 4 últimos caracteres. O
  // contato administrativo VAI inteiro — são dados da própria empresa, e sem
  // devolvê-los a tela não teria como mostrar o que está gravado para revisão.
  app.get('/api/ssl/config', (req, res) => {
    try {
      const token = getConfig(db, 'nicsrs_api_token');
      const admin = getConfig(db, 'nicsrs_administrator');
      const catalogo = db.prepare(
        'SELECT COUNT(*) AS total, MAX(dataAtualizacao) AS ultimaSincronizacao FROM ssl_produtos_nicsrs'
      ).get();
      const porVendor = db.prepare(
        'SELECT vendor, COUNT(*) AS total FROM ssl_produtos_nicsrs GROUP BY vendor ORDER BY vendor'
      ).all();
      res.json({
        success: true,
        config: {
          tokenConfigurado: !!token,
          tokenSufixo: token ? String(token).slice(-4) : null,
          administradorConfigurado: !!admin,
          administrator: admin || null,
          cotacaoUsd: getConfig(db, 'nicsrs_cotacao_usd'),
          cotacaoData: getConfig(db, 'nicsrs_cotacao_usd_data'),
          reissueAntecedenciaDias: antecedenciaReissue(db),
          reissueAutomatico: getConfig(db, 'nicsrs_reissue_automatico', '1') === '1',
        },
        catalogo: { ...catalogo, porVendor },
        dcvMetodos: DCV_METODOS,
        status: STATUS,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/ssl/config', async (req, res) => {
    try {
      // A cotação não é mais campo de formulário: vem da PTAX no dia da compra.
      const { apiToken, administrator, reissueAntecedenciaDias, reissueAutomatico } = req.body;
      if (apiToken !== undefined && apiToken !== null && String(apiToken).trim()) {
        const novo = String(apiToken).trim();
        // Valida ANTES de gravar. O campo é type=password numa página que o
        // Chrome já confundiu com formulário de login: sem esta checagem, uma
        // senha autopreenchida substituiria um token que funciona, derrubando
        // a integração inteira em silêncio.
        try {
          await nicsrs.productList(novo, 'Sectigo');
        } catch (err) {
          return res.status(400).json({ success: false,
            error: `Token recusado pela NicSRS, nada foi alterado: ${err.message}` });
        }
        setConfig(db, 'nicsrs_api_token', novo);
      }
      if (administrator !== undefined) {
        setConfig(db, 'nicsrs_administrator', typeof administrator === 'string' ? administrator : JSON.stringify(administrator));
      }
      if (reissueAntecedenciaDias !== undefined) setConfig(db, 'nicsrs_reissue_antecedencia_dias', reissueAntecedenciaDias);
      if (reissueAutomatico !== undefined) setConfig(db, 'nicsrs_reissue_automatico', reissueAutomatico ? '1' : '0');
      logAction(db, req, 'configurar', 'ssl-nicsrs', null, { apiToken: apiToken ? '(alterado)' : undefined });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Testa o token com uma chamada barata e sem efeito colateral.
  app.post('/api/ssl/config/testar', async (req, res) => {
    try {
      const vendor = req.body.vendor || 'Sectigo';
      const r = await nicsrs.productList(getToken(db), vendor);
      const qtd = Array.isArray(r.data) ? r.data.length : (r.data ? Object.keys(r.data).length : 0);
      res.json({ success: true, vendor, produtos: qtd });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ==================== CATÁLOGO NICSRS ====================

  app.get('/api/ssl/produtos', (req, res) => {
    try {
      const { vendor } = req.query;
      const sql = vendor
        ? 'SELECT * FROM ssl_produtos_nicsrs WHERE vendor = ? ORDER BY productName'
        : 'SELECT * FROM ssl_produtos_nicsrs ORDER BY vendor, productName';
      const produtos = (vendor ? db.prepare(sql).all(vendor) : db.prepare(sql).all()).map(p => ({
        ...p,
        basePrice: p.basePrice ? JSON.parse(p.basePrice) : null,
        sanPrice: p.sanPrice ? JSON.parse(p.sanPrice) : null,
      }));
      res.json({ success: true, produtos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/ssl/produtos/sincronizar', async (req, res) => {
    try {
      const vendors = Array.isArray(req.body.vendors) && req.body.vendors.length ? req.body.vendors : null;
      const resultado = await sincronizarProdutos(db, getToken(db), vendors);
      logAction(db, req, 'sincronizar', 'ssl-produtos', null, { vendors: vendors || VENDORS });
      res.json({ success: true, resultado });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CERTIFICADOS ====================

  // Traz o que já existe na conta NicSRS. Só lê da API — não compra nada.
  app.post('/api/ssl/certificados/importar', async (req, res) => {
    try {
      const resumo = await importarDaNicsrs(db, getToken(db), {
        comCollect: req.body.comCollect !== false,
      });
      // Lançar no financeiro é OPT-IN. A importação traz o histórico inteiro da
      // conta, e boa parte dessas compras já costuma estar lançada por outro
      // caminho (fatura do cartão, recarga de saldo) — disparar por padrão
      // duplicaria despesa antiga sem ninguém pedir.
      if (req.body.lancarFinanceiro === true) {
        resumo.financeiro = lancarComprasNoFinanceiro(db, await obterCotacaoUsd(db));
      }
      logAction(db, req, 'importar', 'ssl-certificado', null, resumo);
      res.json({ success: true, ...resumo });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  /**
   * Amarra certificados a um contrato/cliente. Separado do PUT porque é
   * metadado NOSSO: não vai para a NicSRS e por isso vale em qualquer status —
   * sem esta rota, certificado importado (que nasce 'emitido') nunca poderia
   * ser vinculado. Aceita lista porque um pedido costuma cobrir vários
   * domínios do mesmo cliente.
   */
  app.post('/api/ssl/certificados/vincular', (req, res) => {
    try {
      const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ success: false, error: 'Informe ao menos um certificado' });

      let { contratoId, clienteId, contratoItemId } = req.body;
      contratoId = contratoId ? Number(contratoId) : null;
      clienteId = clienteId ? Number(clienteId) : null;
      contratoItemId = contratoItemId ? Number(contratoItemId) : null;

      if (contratoItemId) {
        const item = db.prepare('SELECT id, contratoId FROM contratos_itens WHERE id = ?').get(contratoItemId);
        if (!item) return res.status(404).json({ success: false, error: `Item #${contratoItemId} não encontrado` });
        // O item já sabe de qual contrato é: não deixa apontar para outro.
        if (contratoId && contratoId !== item.contratoId) {
          return res.status(400).json({ success: false, error: 'O item informado pertence a outro contrato' });
        }
        contratoId = item.contratoId;
      }

      if (contratoId) {
        const contrato = db.prepare('SELECT id, clienteId, numero FROM contratos WHERE id = ?').get(contratoId);
        if (!contrato) return res.status(404).json({ success: false, error: `Contrato #${contratoId} não encontrado` });
        // O contrato já sabe de quem é: não faz sentido pedir o cliente de novo.
        if (!clienteId) clienteId = contrato.clienteId;
      }
      if (clienteId) {
        const p = db.prepare('SELECT id FROM pessoas WHERE id = ?').get(clienteId);
        if (!p) return res.status(404).json({ success: false, error: `Cliente #${clienteId} não encontrado` });
      }

      const upd = db.prepare(`
        UPDATE ssl_certificados
        SET contratoId = ?, clienteId = ?, contratoItemId = ?, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      const trx = db.transaction(() => {
        for (const id of ids) {
          upd.run(contratoId, clienteId, contratoItemId, id);
          registrarEvento(db, id, 'vinculo',
            contratoId
              ? `Vinculado ao contrato #${contratoId}${contratoItemId ? ` (item #${contratoItemId})` : ''}`
              : 'Vínculo de contrato removido',
            { contratoId, clienteId, contratoItemId }, req.user?.username);
        }
      });
      trx();
      logAction(db, req, 'vincular', 'ssl-certificado', null, { ids, contratoId, clienteId, contratoItemId });
      res.json({ success: true, vinculados: ids.length, contratoId, clienteId, contratoItemId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Repassa os preços da NicSRS (US$) para o catálogo de produtos (R$).
  app.post('/api/ssl/produtos/atualizar-precos', async (req, res) => {
    try {
      const cotacao = await obterCotacaoUsd(db);
      const resumo = atualizarPrecosProdutos(db, cotacao, {
        recalcularVenda: req.body.recalcularVenda !== false,
      });
      // Produto que a API oferece e o catálogo não tem: sem ele não há o que
      // vincular num item de contrato.
      if (req.body.criarFaltantes && resumo.semProdutoLocal.length) {
        resumo.criados = criarProdutosFaltantes(db, cotacao, resumo.semProdutoLocal);
        resumo.semProdutoLocal = [];
      }
      logAction(db, req, 'atualizar-precos', 'ssl-produtos', null,
        { atualizados: resumo.atualizados, cotacao: resumo.cotacao });
      res.json({ success: true, ...resumo });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  /**
   * Contexto para emitir a partir de um item de contrato: o que a tela precisa
   * pré-preencher (produto, contrato, cliente) e o quanto já foi consumido.
   */
  app.get('/api/ssl/contexto-item/:itemId', (req, res) => {
    try {
      const item = db.prepare(`
        SELECT i.id, i.contratoId, i.descricao, i.quantidade, i.periodicidade, i.produtoId,
               i.valorUnitario, c.numero AS contratoNumero, c.clienteId, c.dataInicio, c.dataFim,
               c.prazoRenovacaoMeses, p.razaoSocial AS clienteNome,
               s.code AS productCode, s.productName, s.vendor, s.maxYear
        FROM contratos_itens i
        JOIN contratos c ON c.id = i.contratoId
        LEFT JOIN pessoas p ON p.id = c.clienteId
        LEFT JOIN ssl_produtos_nicsrs s ON s.produtoId = i.produtoId
        WHERE i.id = ?
      `).get(Number(req.params.itemId));
      if (!item) return res.status(404).json({ success: false, error: 'Item de contrato não encontrado' });

      const emitidos = db.prepare(`
        SELECT COUNT(*) AS total FROM ssl_certificados
        WHERE contratoItemId = ? AND status NOT IN ('cancelado','substituido')
      `).get(item.id).total;
      res.json({ success: true, item, emitidos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // E-mails que a CA aceita para aprovar o domínio. Derivados do domínio pela
  // regra do CA/Browser Forum — a NicSRS não expõe endpoint para isso.
  app.get('/api/ssl/dcv-emails', (req, res) => {
    try {
      const cn = req.query.commonName || '';
      res.json({ success: true, emails: emailsAprovadores(cn), dominios: dominiosParaDcv(cn) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Lê o CSR colado: devolve o domínio e os SANs que estão dentro dele.
  app.post('/api/ssl/csr/inspecionar', async (req, res) => {
    try {
      res.json({ success: true, csr: await inspecionarCSR(req.body.csr) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Cotação vigente do dólar (PTAX/BCB), para a tela mostrar o custo em reais.
  app.get('/api/ssl/cotacao', async (req, res) => {
    try {
      res.json({ success: true, cotacao: await obterCotacaoUsd(db, { forcar: req.query.forcar === '1' }) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/ssl/certificados', (req, res) => {
    try {
      const { contratoId, clienteId, status, q, limit } = req.query;
      let sql = `
        SELECT s.*, p.razaoSocial AS clienteNome, c.numero AS contratoNumero
        FROM ssl_certificados s
        LEFT JOIN pessoas p ON p.id = s.clienteId
        LEFT JOIN contratos c ON c.id = s.contratoId
        WHERE 1=1
      `;
      const params = [];
      if (contratoId) { sql += ' AND s.contratoId = ?'; params.push(Number(contratoId)); }
      if (clienteId)  { sql += ' AND s.clienteId = ?';  params.push(Number(clienteId)); }
      if (status)     { sql += ' AND s.status = ?';     params.push(status); }
      if (q) { sql += ' AND (s.commonName LIKE ? OR s.dominiosSan LIKE ? OR s.certId = ?)'; params.push(`%${q}%`, `%${q}%`, q); }
      sql += ' ORDER BY s.id DESC LIMIT ?';
      params.push(Number(limit) || 200);
      const certificados = db.prepare(sql).all(...params);

      const kpis = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status='emitido' THEN 1 ELSE 0 END) AS emitidos,
          SUM(CASE WHEN status='aguardando-aprovacao' THEN 1 ELSE 0 END) AS aguardandoAprovacao,
          SUM(CASE WHEN status='aguardando-dados' THEN 1 ELSE 0 END) AS aguardandoDados,
          SUM(CASE WHEN status IN ('comprado','reemitindo') THEN 1 ELSE 0 END) AS emAndamento,
          SUM(CASE WHEN status='emitido' AND endDate IS NOT NULL AND date(endDate) <= date('now','+30 days') THEN 1 ELSE 0 END) AS arquivoVencendo30d,
          SUM(CASE WHEN cobertoAte IS NOT NULL AND date(cobertoAte) <= date('now','+90 days') AND status NOT IN ('cancelado','expirado') THEN 1 ELSE 0 END) AS assinaturaVencendo90d
        FROM ssl_certificados
      `).get();

      res.json({ success: true, certificados, kpis, status: STATUS, dcvMetodos: DCV_METODOS });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/ssl/certificados/:id', (req, res) => {
    try {
      const cert = db.prepare(`
        SELECT s.*, p.razaoSocial AS clienteNome, p.email AS clienteEmail, c.numero AS contratoNumero
        FROM ssl_certificados s
        LEFT JOIN pessoas p ON p.id = s.clienteId
        LEFT JOIN contratos c ON c.id = s.contratoId
        WHERE s.id = ?
      `).get(Number(req.params.id));
      if (!cert) return res.status(404).json({ success: false, error: 'Certificado não encontrado' });
      const eventos = db.prepare('SELECT * FROM ssl_certificados_eventos WHERE certificadoId = ? ORDER BY id DESC').all(cert.id);
      res.json({ success: true, certificado: cert, eventos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/ssl/certificados', (req, res) => {
    try {
      const { contratoId, clienteId, produtoId, productCode, productName, vendor,
              commonName, dominiosSan, anos, csr, servidor, dcvMethod, dcvEmail,
              uniqueValue, custoUsd, observacoes,
              contatoAdmin, contatoFinanceiro, contatoTecnico } = req.body;
      // Emitido a partir de um item de contrato: o item manda o contrato e o
      // cliente, para não haver certificado apontando para item de um contrato
      // e para o cliente de outro.
      let contratoIdFinal = contratoId ? Number(contratoId) : null;
      let clienteIdFinal = clienteId ? Number(clienteId) : null;
      const contratoItemId = req.body.contratoItemId ? Number(req.body.contratoItemId) : null;
      if (contratoItemId) {
        const item = db.prepare(`
          SELECT i.id, i.contratoId, c.clienteId
          FROM contratos_itens i JOIN contratos c ON c.id = i.contratoId
          WHERE i.id = ?
        `).get(contratoItemId);
        if (!item) return res.status(404).json({ success: false, error: `Item de contrato #${contratoItemId} não encontrado` });
        contratoIdFinal = item.contratoId;
        if (!clienteIdFinal) clienteIdFinal = item.clienteId;
      }
      if (!productCode || !commonName) {
        return res.status(400).json({ success: false, error: 'productCode e commonName obrigatórios' });
      }
      const metodo = dcvMethod || 'CNAME_CSR_HASH';
      if (!DCV_METODOS.includes(metodo)) {
        return res.status(400).json({ success: false, error: `dcvMethod inválido (use ${DCV_METODOS.join(', ')})` });
      }
      if (metodo === 'EMAIL' && !dcvEmail) {
        return res.status(400).json({ success: false, error: 'dcvEmail obrigatório quando dcvMethod=EMAIL' });
      }
      // Sem CSR não dá para comprar: fica rascunho até colarem.
      const status = csr ? 'aguardando-aprovacao' : 'rascunho';
      const r = db.prepare(`
        INSERT INTO ssl_certificados
          (contratoId, clienteId, contratoItemId, produtoId, productCode, productName, vendor, commonName,
           dominiosSan, anos, csr, servidor, dcvMethod, dcvEmail, uniqueValue, custoUsd,
           status, observacoes, contatoAdmin, contatoFinanceiro, contatoTecnico)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        contratoIdFinal, clienteIdFinal, contratoItemId, produtoId || null,
        productCode, productName || null, vendor || null, commonName,
        dominiosSan ? JSON.stringify(dominiosSan) : null,
        Number(anos) || 1, csr || null, servidor || 'NGINX', metodo, dcvEmail || null,
        uniqueValue || null, custoUsd != null ? Number(custoUsd) : null,
        status, observacoes || null,
        contatoAdmin ? JSON.stringify(contatoAdmin) : null,
        contatoFinanceiro ? JSON.stringify(contatoFinanceiro) : null,
        contatoTecnico ? JSON.stringify(contatoTecnico) : null
      );
      const id = r.lastInsertRowid;
      registrarEvento(db, id, 'cadastro', `Certificado cadastrado para ${commonName}`, null, req.user?.username);
      logAction(db, req, 'criar', 'ssl-certificado', id, { commonName, productCode });
      res.json({ success: true, id, status });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/ssl/certificados/:id', async (req, res) => {
    try {
      const cert = db.prepare('SELECT * FROM ssl_certificados WHERE id = ?').get(Number(req.params.id));
      if (!cert) return res.status(404).json({ success: false, error: 'Certificado não encontrado' });
      // Depois de submetido à CA, o que muda aqui precisa TAMBÉM mudar lá —
      // senão o nosso registro diverge em silêncio do que está sendo validado.
      // O que a API permite alterar depois do envio:
      //   DCV  -> /ssl/updateDCV, vale com o certificado em validação
      //   CSR  -> /ssl/reissue, só depois de EMITIDO (em validação devolve -7)
      const ANTES_DA_CA = ['rascunho', 'aguardando-aprovacao', 'aguardando-dados'];
      const SO_GESTAO = ['contatoAdmin', 'contatoFinanceiro', 'contatoTecnico',
                         'custoUsd', 'observacoes', 'contratoId', 'clienteId', 'contratoItemId'];
      const livre = ANTES_DA_CA.includes(cert.status);
      const efeitos = [];

      if (!livre) {
        const mudouDcv = (req.body.dcvMethod !== undefined && req.body.dcvMethod !== cert.dcvMethod)
                      || (req.body.dcvEmail !== undefined && req.body.dcvEmail !== cert.dcvEmail);
        const mudouCsr = req.body.csr !== undefined && req.body.csr !== cert.csr;

        if (mudouDcv) {
          if (!cert.certId) {
            return res.status(409).json({ success: false,
              error: 'Sem certId da NicSRS: sincronize o certificado antes de trocar a validação' });
          }
          const metodoNovo = req.body.dcvMethod || cert.dcvMethod;
          const emailNovo = req.body.dcvEmail !== undefined ? req.body.dcvEmail : cert.dcvEmail;
          if (metodoNovo === 'EMAIL' && !emailNovo) {
            return res.status(400).json({ success: false, error: 'Informe o e-mail aprovador' });
          }
          try {
            await nicsrs.updateDCV(getToken(db), {
              certId: cert.certId,
              domainName: cert.commonName,
              dcvMethod: metodoNovo,
              dcvEmail: metodoNovo === 'EMAIL' ? emailNovo : undefined,
            });
            efeitos.push(`validação alterada na NicSRS para ${metodoNovo}`);
            registrarEvento(db, cert.id, 'dcv-alterado',
              `DCV alterado para ${metodoNovo}${emailNovo ? ' (' + emailNovo + ')' : ''}`, null, req.user?.username);
          } catch (err) {
            return res.status(502).json({ success: false, error: `NicSRS recusou a troca de validação: ${err.message}` });
          }
        }

        if (mudouCsr) {
          // O painel PERMITE trocar o CSR de um certificado em validação —
          // verificado na tela em 2026-08-21. O que falta é o endpoint: a API
          // de revenda não expõe essa alteração (o /ssl/reissue devolve -7
          // porque só opera sobre certificado já emitido, e isso diz respeito
          // àquele endpoint, não à plataforma).
          //
          // Enquanto o endpoint do console não for mapeado, trocar aqui
          // gravaria um CSR que a CA não conhece. Por isso a recusa — que é
          // limitação nossa, não da NicSRS.
          if (cert.status === 'emitido') {
            return res.status(409).json({ success: false,
              error: 'Para trocar o CSR de um certificado emitido use a ação "Reemitir", que registra o motivo exigido pela CA' });
          }
          return res.status(409).json({ success: false,
            error: 'A troca de CSR ainda não é enviada pelo sistema — faça pelo painel NicSRS (o certificado em validação aceita edição). '
                 + 'Assim que o endpoint de alteração for mapeado, passa a funcionar por aqui.' });
        }

        const permitido = [...SO_GESTAO, 'dcvMethod', 'dcvEmail'];
        const bloqueados = Object.keys(req.body).filter(k => !permitido.includes(k));
        if (bloqueados.length) {
          return res.status(409).json({ success: false,
            error: `Certificado já submetido à CA (status ${cert.status}): ${bloqueados.join(', ')} não pode(m) mudar aqui. `
                 + `Editável: validação (DCV), contatos, custo, observações e vínculo com contrato.` });
        }
      }
      const campos = ['contratoId', 'clienteId', 'produtoId', 'productCode', 'productName', 'vendor',
                      'commonName', 'anos', 'csr', 'servidor', 'dcvMethod', 'dcvEmail', 'uniqueValue',
                      'custoUsd', 'observacoes'];
      const sets = [];
      const valores = [];
      // Contatos chegam como objeto e vão para a coluna como JSON.
      for (const papel of ['contatoAdmin', 'contatoFinanceiro', 'contatoTecnico']) {
        if (req.body[papel] !== undefined) {
          sets.push(`${papel} = ?`);
          valores.push(req.body[papel] ? JSON.stringify(req.body[papel]) : null);
        }
      }
      for (const campo of campos) {
        if (req.body[campo] !== undefined) { sets.push(`${campo} = ?`); valores.push(req.body[campo]); }
      }
      if (req.body.dominiosSan !== undefined) {
        sets.push('dominiosSan = ?');
        valores.push(req.body.dominiosSan ? JSON.stringify(req.body.dominiosSan) : null);
      }
      if (!sets.length) return res.json({ success: true, alterado: false, efeitos });

      // Colar o CSR é o que tira do rascunho.
      const csrFinal = req.body.csr !== undefined ? req.body.csr : cert.csr;
      if (cert.status === 'rascunho' && csrFinal) { sets.push("status = 'aguardando-aprovacao'"); }

      sets.push('dataAtualizacao = CURRENT_TIMESTAMP');
      valores.push(cert.id);
      db.prepare(`UPDATE ssl_certificados SET ${sets.join(', ')} WHERE id = ?`).run(...valores);
      logAction(db, req, 'editar', 'ssl-certificado', cert.id, {});
      res.json({ success: true, alterado: true, efeitos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ---- Gera o pedido de compra. A compra real só acontece quando o pedido
  //      for ENVIADO no módulo de Compras, depois da alçada.
  app.post('/api/ssl/certificados/:id/pedido-compra', async (req, res) => {
    try {
      const r = gerarPedidoCompra(db, Number(req.params.id), await obterCotacaoUsd(db), req.user?.username);
      logAction(db, req, 'gerar-pedido-compra', 'ssl-certificado', Number(req.params.id), r);
      res.json({ success: true, ...r });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ---- COMPRA: único ponto que gasta saldo. Sempre manual, sempre explícito.
  app.post('/api/ssl/certificados/:id/aprovar', async (req, res) => {
    try {
      const cert = db.prepare('SELECT * FROM ssl_certificados WHERE id = ?').get(Number(req.params.id));
      if (!cert) return res.status(404).json({ success: false, error: 'Certificado não encontrado' });
      if (cert.status !== 'aguardando-aprovacao') {
        return res.status(409).json({ success: false, error: `Só é possível comprar em status aguardando-aprovacao (atual: ${cert.status})` });
      }
      if (!cert.csr) return res.status(400).json({ success: false, error: 'CSR não informado' });

      const administrator = administradorPadrao(db, req.body.administrator);
      const refId = cert.refId || gerarRefId(db, cert.id);
      // Grava o refId ANTES da chamada: se a resposta se perder, o retry usa o
      // mesmo refId e a NicSRS não cobra duas vezes.
      db.prepare('UPDATE ssl_certificados SET refId = ? WHERE id = ?').run(refId, cert.id);

      const params = montarParams(db, cert, administrator, req.body.organizationInfo);

      // NÃO existe ensaio antes da compra.
      //
      // Tentei usar /ssl/validate como dry-run (assinatura idêntica à do place
      // e reclama dos mesmos campos), mas ele devolve -1 para TODO payload —
      // inclusive para o `applyParams` recuperado de uma compra que a própria
      // NicSRS aprovou e emitiu. Não é ensaio de pedido, seja lá o que for, e
      // não está entre os 17 endpoints documentados. Não reintroduzir.
      let resposta;
      try {
        resposta = await nicsrs.place(getToken(db), {
          productCode: cert.productCode,
          years: cert.anos || 1,
          refId,
          params,
        });
      } catch (err) {
        db.prepare('UPDATE ssl_certificados SET ultimoErro = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(err.message, cert.id);
        registrarEvento(db, cert.id, 'erro-compra', err.message, null, req.user?.username);
        return res.status(400).json({ success: false, error: err.message });
      }

      const certId = resposta.data && resposta.data.certId ? String(resposta.data.certId) : null;
      const custoUsd = req.body.custoUsd != null ? Number(req.body.custoUsd) : cert.custoUsd;
      // Cotação buscada no momento da compra: é a data do fato gerador.
      const cotacao = await obterCotacaoUsd(db);
      const financeiro = lancarContaPagar(db, cert, custoUsd, req.body.custoBrl, cotacao);

      db.prepare(`
        UPDATE ssl_certificados SET
          certId = ?, status = 'comprado', statusNicsrs = 'PENDING', dataCompra = ?,
          custoUsd = ?, custoBrl = ?, contaPagarId = ?, ultimoErro = NULL,
          dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(certId, hojeIso(), custoUsd != null ? custoUsd : null,
             financeiro.custoBrl, financeiro.contaPagarId, cert.id);

      registrarEvento(db, cert.id, 'compra',
        `Comprado na NicSRS (certId ${certId})${financeiro.motivo ? ` — conta a pagar não lançada: ${financeiro.motivo}` : ''}`,
        { certId, refId, custoUsd, custoBrl: financeiro.custoBrl }, req.user?.username);
      logAction(db, req, 'comprar', 'ssl-certificado', cert.id, { certId, custoUsd });

      res.json({ success: true, certId, contaPagarId: financeiro.contaPagarId, avisoFinanceiro: financeiro.motivo });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ---- Sincroniza status/material com a NicSRS
  app.post('/api/ssl/certificados/:id/sincronizar', async (req, res) => {
    try {
      const cert = db.prepare('SELECT * FROM ssl_certificados WHERE id = ?').get(Number(req.params.id));
      if (!cert) return res.status(404).json({ success: false, error: 'Certificado não encontrado' });
      if (!cert.certId) return res.status(400).json({ success: false, error: 'Certificado ainda não comprado' });

      const resposta = await nicsrs.collect(getToken(db), cert.certId);
      const aplicado = aplicarCollect(db, cert, resposta);
      if (aplicado.status !== cert.status) {
        registrarEvento(db, cert.id, 'status', `Status ${cert.status} → ${aplicado.status}`, aplicado, req.user?.username);
      }
      res.json({ success: true, ...aplicado });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ---- Reissue manual (o automático fica no scheduler)
  app.post('/api/ssl/certificados/:id/reemitir', async (req, res) => {
    try {
      const cert = db.prepare('SELECT * FROM ssl_certificados WHERE id = ?').get(Number(req.params.id));
      if (!cert) return res.status(404).json({ success: false, error: 'Certificado não encontrado' });
      if (cert.status !== 'emitido') {
        return res.status(409).json({ success: false, error: `Só certificado emitido pode ser reemitido (atual: ${cert.status})` });
      }
      const reason = req.body.reason || 'Renovacao periodica dentro da assinatura (limite de validade de 200 dias)';
      const resposta = await nicsrs.reissue(getToken(db), {
        certId: cert.certId,
        reason,
        uniqueValue: cert.uniqueValue || undefined,
        refId: `${cert.refId || cert.id}-R${cert.reissuesFeitos + 1}`,
      });
      const novoCertId = resposta.data && resposta.data.certId ? String(resposta.data.certId) : cert.certId;
      db.prepare(`
        UPDATE ssl_certificados SET
          certId = ?, status = 'reemitindo', statusNicsrs = 'PENDING',
          reissuesFeitos = reissuesFeitos + 1, proximoReissueEm = NULL,
          ultimoErro = NULL, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(novoCertId, cert.id);
      registrarEvento(db, cert.id, 'reissue', `Reemissão solicitada (certId ${novoCertId})`, { reason }, req.user?.username);
      logAction(db, req, 'reemitir', 'ssl-certificado', cert.id, { certId: novoCertId });
      res.json({ success: true, certId: novoCertId });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ---- Troca de método DCV com o pedido em andamento
  app.post('/api/ssl/certificados/:id/dcv', async (req, res) => {
    try {
      const cert = db.prepare('SELECT * FROM ssl_certificados WHERE id = ?').get(Number(req.params.id));
      if (!cert) return res.status(404).json({ success: false, error: 'Certificado não encontrado' });
      if (!cert.certId) return res.status(400).json({ success: false, error: 'Certificado ainda não comprado' });
      const { dcvMethod, dcvEmail, domainName } = req.body;
      if (!DCV_METODOS.includes(dcvMethod)) {
        return res.status(400).json({ success: false, error: `dcvMethod inválido (use ${DCV_METODOS.join(', ')})` });
      }
      await nicsrs.updateDCV(getToken(db), { certId: cert.certId, domainName, dcvMethod, dcvEmail });
      db.prepare('UPDATE ssl_certificados SET dcvMethod = ?, dcvEmail = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
        .run(dcvMethod, dcvEmail || null, cert.id);
      registrarEvento(db, cert.id, 'dcv', `DCV alterado para ${dcvMethod}${domainName ? ` em ${domainName}` : ''}`, null, req.user?.username);
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ---- Cancelamento (estorna se dentro do prazo)
  app.post('/api/ssl/certificados/:id/cancelar', async (req, res) => {
    try {
      const cert = db.prepare('SELECT * FROM ssl_certificados WHERE id = ?').get(Number(req.params.id));
      if (!cert) return res.status(404).json({ success: false, error: 'Certificado não encontrado' });
      const reason = req.body.reason;
      if (!reason) return res.status(400).json({ success: false, error: 'reason obrigatório' });

      if (cert.certId) {
        await nicsrs.cancel(getToken(db), { certId: cert.certId, reason });
      }
      db.prepare("UPDATE ssl_certificados SET status = 'cancelado', proximoReissueEm = NULL, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(cert.id);
      registrarEvento(db, cert.id, 'cancelamento', reason, null, req.user?.username);
      logAction(db, req, 'cancelar', 'ssl-certificado', cert.id, { reason });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ---- Envio do material ao cliente
  app.post('/api/ssl/certificados/:id/enviar-email', async (req, res) => {
    try {
      const cert = db.prepare(`
        SELECT s.*, p.razaoSocial AS clienteNome, p.email AS clienteEmail
        FROM ssl_certificados s LEFT JOIN pessoas p ON p.id = s.clienteId WHERE s.id = ?
      `).get(Number(req.params.id));
      if (!cert) return res.status(404).json({ success: false, error: 'Certificado não encontrado' });
      if (!cert.certificado) return res.status(400).json({ success: false, error: 'Certificado ainda não emitido' });
      const to = req.body.to || cert.clienteEmail;
      if (!to) return res.status(400).json({ success: false, error: 'Destinatário não informado e cliente sem e-mail' });

      const texto = [
        `Olá${cert.clienteNome ? `, ${cert.clienteNome}` : ''},`,
        '',
        `Segue o certificado SSL de ${cert.commonName}.`,
        `Válido de ${cert.beginDate || '-'} até ${cert.endDate || '-'}.`,
        '',
        '--- CERTIFICADO ---',
        cert.certificado,
        '',
        '--- CADEIA INTERMEDIÁRIA ---',
        cert.caCertificate || '(não informada)',
      ].join('\n');

      await enviarEmailSimples(db, {
        to,
        assunto: `Certificado SSL — ${cert.commonName}`,
        texto,
      });
      registrarEvento(db, cert.id, 'envio', `Certificado enviado para ${to}`, null, req.user?.username);
      logAction(db, req, 'enviar', 'ssl-certificado', cert.id, { to });
      res.json({ success: true, to });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ---- Download do material emitido
  app.get('/api/ssl/certificados/:id/download', (req, res) => {
    try {
      const cert = db.prepare('SELECT * FROM ssl_certificados WHERE id = ?').get(Number(req.params.id));
      if (!cert) return res.status(404).json({ success: false, error: 'Certificado não encontrado' });
      if (!cert.certificado) return res.status(400).json({ success: false, error: 'Certificado ainda não emitido' });
      const corpo = [cert.certificado, cert.caCertificate].filter(Boolean).join('\n');
      const nome = `${cert.commonName.replace(/[^a-zA-Z0-9.-]/g, '_')}.crt`;
      res.setHeader('Content-Type', 'application/x-pem-file');
      res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
      res.send(corpo);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ---- Agenda: o que o scheduler faria hoje (leitura, não executa nada)
  app.get('/api/ssl/agenda', (req, res) => {
    try {
      const hoje = hojeIso();
      const reissuePendente = db.prepare(`
        SELECT id, commonName, endDate, cobertoAte, proximoReissueEm
        FROM ssl_certificados
        WHERE status = 'emitido' AND proximoReissueEm IS NOT NULL AND date(proximoReissueEm) <= date(?)
        ORDER BY proximoReissueEm
      `).all(hoje);
      const renovacaoPendente = db.prepare(`
        SELECT s.id, s.commonName, s.cobertoAte, c.numero AS contratoNumero, c.status AS contratoStatus
        FROM ssl_certificados s
        LEFT JOIN contratos c ON c.id = s.contratoId
        WHERE s.status IN ('emitido','comprado') AND s.cobertoAte IS NOT NULL
          AND date(s.cobertoAte) <= date('now','+90 days')
        ORDER BY s.cobertoAte
      `).all();
      res.json({ success: true, reissuePendente, renovacaoPendente });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = {
  registrarRotasSslCertificados,
  migrarDB,
  sincronizarProdutos,
  atualizarPrecosProdutos,
  criarProdutosFaltantes,
  gerarPedidoCompra,
  comprarAssinaturasDoPedido,
  organizacaoDoCliente,
  comprarCertificadosDoPedido,
  lancarComprasNoFinanceiro,
  inspecionarCSR,
  emailsAprovadores,
  dominiosParaDcv,
  importarDaNicsrs,
  obterCotacaoUsd,
  VENDORS,
  aplicarCollect,
  antecedenciaReissue,
  registrarEvento,
  getConfig,
  addDias,
  hojeIso,
  STATUS,
  DCV_METODOS,
};
