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
const sslRelatorio = require('./ssl-certificados-relatorio');

// `em-validacao`: dados já submetidos à CA, esperando DCV (aprovação do
// domínio) e OV (validação da organização). Não é `reemitindo`, que é o ciclo
// de renovação do arquivo dentro de uma assinatura já emitida.
const STATUS = ['rascunho', 'aguardando-aprovacao', 'aguardando-dados', 'comprado',
                'em-validacao', 'emitido', 'reemitindo', 'substituido', 'cancelado', 'expirado'];
const DCV_METODOS = ['EMAIL', 'HTTP_CSR_HASH', 'CNAME_CSR_HASH', 'HTTPS_CSR_HASH'];

// Antecedência padrão do reissue: 15 dias antes do arquivo atual expirar.
const REISSUE_ANTECEDENCIA_PADRAO = 15;
// ...mas só até 1/4 da vida do arquivo — ver antecedenciaReissue(). Em 199 dias
// o teto de 15 continua valendo; em 47 dias a antecedência cai para ~12.
const REISSUE_FRACAO_VALIDADE = 0.25;

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
      supportStandard TEXT,
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

  // `supportStandard` diz se o produto aceita domínio sem curinga. Sem ele não
  // dava para saber que um "Wildcard DV" recusa `dominio.com.br` — e a recusa
  // só aparecia depois da ida à NicSRS.
  try {
    db.exec('ALTER TABLE ssl_produtos_nicsrs ADD COLUMN supportStandard TEXT');
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

  // Id numérico do produto no PAINEL. O order/create da API do console não
  // aceita o `code` — só este id. Guardado aqui para não consultar a NicSRS a
  // cada compra; é estável (conferido nos 69 produtos em 2026-08-29).
  try {
    db.exec('ALTER TABLE ssl_produtos_nicsrs ADD COLUMN consoleProductId TEXT');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  try {
    db.exec('ALTER TABLE ssl_produtos_nicsrs ADD COLUMN consolePeriodType INTEGER');
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

/**
 * Antecedência do reissue, em dias.
 *
 * O valor configurado é um TETO, não uma constante: 15 dias sobre um arquivo de
 * 199 dias é 7,5% da vida dele, mas sobre um de 47 dias seria 32% — um terço do
 * certificado jogado fora, e um ciclo de reemissão a cada 32 dias. Como o teto
 * de validade das CAs vem caindo (398 → 200 → 47 dias), a antecedência precisa
 * acompanhar a validade real do arquivo em vez de ficar fixa.
 *
 * `validadeDias` é a vida do arquivo (endDate - beginDate). Sem ela — chamada
 * sem contexto de certificado — vale o teto puro, que é o comportamento antigo.
 */
function antecedenciaReissue(db, validadeDias = null) {
  const n = Number(getConfig(db, 'nicsrs_reissue_antecedencia_dias', REISSUE_ANTECEDENCIA_PADRAO));
  const teto = Number.isFinite(n) && n > 0 ? n : REISSUE_ANTECEDENCIA_PADRAO;
  if (!Number.isFinite(validadeDias) || validadeDias <= 0) return teto;
  // Piso de 3 dias: com o scheduler rodando de 12 em 12h, menos que isso deixa
  // poucas tentativas antes de o arquivo expirar.
  const proporcional = Math.max(3, Math.round(validadeDias * REISSUE_FRACAO_VALIDADE));
  return Math.min(teto, proporcional);
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

  // A antecedência acompanha a validade REAL deste arquivo (endDate-beginDate),
  // não um número fixo: é o que mantém a regra correta quando o teto das CAs
  // cair de 200 para 47 dias.
  const validadeDias = (beginDate && endDate)
    ? Math.round((Date.parse(endDate) - Date.parse(beginDate)) / 86400000)
    : null;
  const proximoReissueEm = (status === 'emitido' && endDate && cobertoAte && endDate < cobertoAte)
    ? addDias(endDate, -antecedenciaReissue(db, validadeDias))
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
      (code, vendor, productName, validationType, supportWildcard, supportStandard, supportSan, maxDomain, maxYear, basePrice, sanPrice, dataAtualizacao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(code) DO UPDATE SET
      vendor = excluded.vendor, productName = excluded.productName,
      validationType = excluded.validationType, supportWildcard = excluded.supportWildcard,
      supportStandard = excluded.supportStandard,
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
            p.supportStandard != null ? String(p.supportStandard) : null,
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
 * O caminho certificado → pedido de compra foi REMOVIDO.
 *
 * Ele criava o pedido sem `contratoItemId`, e o pedido solto não encontrava
 * depois o certificado — a busca é pelo item do contrato. A direção válida é
 * contrato → pedido (`/api/contratos/:id/itens/:itemId/pedido-compra`) →
 * certificado, criado ao comprar.
 */

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
      'SELECT code, productName, vendor, validationType, supportWildcard, supportStandard FROM ssl_produtos_nicsrs WHERE produtoId = ?'
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
          // Falta de cadastro, não falha de compra: a tela do pedido usa o item
          // para mandar ao "Novo certificado" de Certificados SSL já amarrado
          // nele, que é onde CSR, DCV, SAN e contatos são preenchidos.
          const e = new Error('nenhum certificado cadastrado para este item — cadastre o certificado '
            + 'em Certificados SSL (domínio, DCV e, se quiser usar o seu, o CSR) antes de comprar');
          e.cadastrarParaItem = pedido.contratoItemId || null;
          throw e;
        }
        // CSR é opcional: sem ele a NicSRS gera o par (system-generated).
        if (!cert.commonName) throw new Error(`certificado #${cert.id} sem domínio principal`);
        // Curinga incompatível com o produto: a mensagem já diz qual domínio
        // usar, e o item leva de volta ao cadastro para corrigir lá.
        const erroCuringa = erroDominioProduto(prod, cert.commonName);
        if (erroCuringa) {
          const e = new Error(`certificado #${cert.id}: ${erroCuringa.mensagem}`);
          e.cadastrarParaItem = pedido.contratoItemId || null;
          throw e;
        }

        const params = montarParams(db, cert, administrator, null);
        // Mesma guarda do /aprovar: comprar pelo pedido de compra usa o mesmo
        // montarParams e falharia igual, com a mesma recusa ilegível da NicSRS.
        const erroContatos = erroDadosOv(params, prod.validationType);
        if (erroContatos) {
          const e = new Error(`certificado #${cert.id}: ${erroContatos}`);
          e.cadastrarParaItem = pedido.contratoItemId || null;
          throw e;
        }
        const resposta = await nicsrs.place(token, { productCode: prod.code, years: anos, refId, params });
        const dados = resposta.data || {};
        const certIdAssinatura = dados.certId ? String(dados.certId) : null;
        const orderNum = dados.orderNum ? String(dados.orderNum) : null;

        // O /ssl/place já devolve o DCV a publicar; guarda para a tela mostrar
        // sem depender do ciclo do scheduler.
        if (dados.DCVdnsHost && dados.DCVdnsValue) {
          db.prepare('UPDATE ssl_certificados SET dcvDetalhe = ? WHERE id = ?').run(
            JSON.stringify({ tipo: dados.DCVdnsType, host: dados.DCVdnsHost, valor: dados.DCVdnsValue }),
            cert.id);
        }
        // Compra sem CSR: o par é da NicSRS e só o /ssl/collect o devolve.
        // Best-effort — falhar aqui não pode desfazer uma compra que deu certo.
        if (!cert.csr && certIdAssinatura) {
          try {
            const col = await nicsrs.collect(token, certIdAssinatura);
            let ap = (col.data || {}).applyParams;
            if (typeof ap === 'string') ap = JSON.parse(ap);
            if (ap && ap.csr) {
              db.prepare('UPDATE ssl_certificados SET csr = ? WHERE id = ?').run(ap.csr, cert.id);
            }
          } catch (err) {
            console.error('[ssl] collect do CSR gerado:', err.message);
          }
        }

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
        falhas.push({
          refId, erro: err.message,
          ...(err.cadastrarParaItem ? { cadastrarParaItem: err.cadastrarParaItem } : {}),
        });
      }
    }
  }

  return {
    modo: 'api',
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
      // Terceiro caminho até o mesmo `place`, e portanto até a mesma recusa.
      // O produto vem pelo código gravado no certificado, não pelo pedido.
      const prodCert = db.prepare('SELECT validationType FROM ssl_produtos_nicsrs WHERE code = ?').get(cert.productCode);
      const erroContatos = erroDadosOv(params, prodCert && prodCert.validationType);
      if (erroContatos) throw new Error(erroContatos);
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

// Onde o console da NicSRS configura a compra de um produto. O `code` é o mesmo
// que já guardamos em ssl_produtos_nicsrs, então o link sai do nosso catálogo.
const NICSRS_CONSOLE = 'https://console.nicsrs.com';
function urlCompraNoPainel(productCode) {
  return `${NICSRS_CONSOLE}/product/config/${encodeURIComponent(productCode)}`;
}

/**
 * Modo de compra do tenant.
 *
 *   'painel' (padrão) — o pedido de compra ABRE o console e a pessoa paga por
 *      PayPal/cartão. É o único caminho possível quando a conta NicSRS não
 *      trabalha com saldo pré-pago: o /ssl/place debita `cash balance`, e sem
 *      saldo devolve -4. O checkout do PayPal é redirecionado e exige duas
 *      confirmações humanas — não há como um job concluir isso.
 *   'api' — compra por /ssl/place, debitando o saldo. Exige recarga prévia
 *      (Billing › Balance recharge no console).
 *
 * Levantado contra a conta 1bit em 2026-08-29, comprando de verdade.
 */
/**
 * Como o sistema compra na NicSRS. Hoje: sempre pela API de revenda.
 *
 * Era configurável entre 'api', 'console' e 'painel', e o seletor saiu da tela
 * de Integração em 16/09/2026 porque só um dos três funciona nesta conta — e a
 * escolha errada não falhava na hora, falhava na compra.
 *
 *   'api'     (o que ficou) — /ssl/place. Comprovado no mesmo dia: o #64
 *                             (homolog.1bit.net.br) voltou `code: 1`. Debita
 *                             saldo pré-pago; sem saldo devolve -2, sem detalhe.
 *   'console' (removido)    — dependia de um refresh_token que expira em ~13 h
 *                             e cuja renovação exige login humano com captcha.
 *                             O token guardado estava morto havia 15 dias.
 *   'painel'  (removido)    — não comprava nada, só registrava e devolvia links.
 *
 * A chave `nicsrs_modo_compra` deixou de ser lida. Ela continua no banco dos
 * tenants e não faz mal nenhum ali; trocá-la não tem mais efeito.
 */
function modoCompra() {
  return 'api';
}

/**
 * Modo 'painel': registra as assinaturas que a pessoa vai comprar no console e
 * devolve os links. NÃO chama a NicSRS e NÃO gasta nada.
 *
 * O registro nasce aqui, antes da compra, pelo mesmo motivo do modo 'api': é o
 * que impede a compra de virar órfã. Foi exatamente o que aconteceu com o
 * CREADF — comprado no painel sem contrapartida local, o pedido de compra ficou
 * aberto e o certificado entrou depois como registro solto.
 *
 * A ligação com o que for comprado é feita pelo `orderNum`, por
 * reconciliarComprasNicsrs().
 */
function registrarComprasNoPainel(db, pedido, itens) {
  const pendentes = [];
  const falhas = [];

  for (const item of itens) {
    const prod = db.prepare(
      'SELECT code, productName, vendor FROM ssl_produtos_nicsrs WHERE produtoId = ?'
    ).get(item.produtoId);
    if (!prod) continue;

    const unidades = Math.max(1, Math.round(Number(item.quantidade) || 1));
    for (let i = 0; i < unidades; i++) {
      const refId = `LA-PC${pedido.id}-I${item.id}-${i + 1}`;
      try {
        db.prepare(`
          INSERT INTO ssl_pedidos_nicsrs
            (pedidoCompraId, contratoItemId, productCode, productName, vendor, anos,
             valorBrl, status, refId, observacoes)
          VALUES (?,?,?,?,?,?,?, 'aguardando-compra', ?, ?)
          ON CONFLICT(refId) DO NOTHING
        `).run(pedido.id, pedido.contratoItemId || null, prod.code, prod.productName, prod.vendor,
               Number(item.anos) || 1, Number(item.custoUnitario) || null, refId,
               `Pedido de compra ${pedido.numero} · unidade ${i + 1}/${unidades} · comprar no painel NicSRS`);
      } catch (err) {
        falhas.push({ refId, erro: err.message });
        continue;
      }
      const reg = db.prepare('SELECT id, status, orderNum FROM ssl_pedidos_nicsrs WHERE refId = ?').get(refId);
      // Já comprada num envio anterior: não pede de novo.
      if (reg && reg.orderNum) continue;
      pendentes.push({
        refId,
        pedidoNicsrsId: reg ? reg.id : null,
        productCode: prod.code,
        productName: prod.productName,
        anos: Number(item.anos) || 1,
        url: urlCompraNoPainel(prod.code),
      });
    }
  }

  return {
    modo: 'painel',
    resumo: pendentes.length
      ? `${pendentes.length} assinatura(s) a comprar no painel da NicSRS`
      : 'nada a comprar — todas as assinaturas deste pedido já têm ordem',
    pendentes, compradas: [], falhas,
    parcial: false,
    nenhuma: pendentes.length === 0 && falhas.length > 0,
  };
}

/**
 * Quando a sessão do painel deixa de valer, lido do próprio refresh token.
 *
 * Só a data: o token é credencial e não sai daqui. Serve para a tela avisar
 * antes de a compra começar a falhar — o refresh vale ~13h e cada renovação
 * emite um novo, então a sessão só morre se o sistema ficar parado.
 */
function expiracaoRefreshConsole(db) {
  const t = getConfig(db, 'nicsrs_console_refresh_token');
  if (!t) return null;
  try {
    const p = JSON.parse(Buffer.from(String(t).split('.')[1], 'base64').toString('utf8'));
    return p.exp ? new Date(p.exp * 1000).toISOString() : null;
  } catch { return null; }
}

/**
 * Modo 'console': cria as ordens de verdade, pela API do painel.
 *
 * A ordem nasce SEM PAGAMENTO — é o mesmo que o botão "Buy" do console faz. O
 * pagamento (PayPal/cartão) continua sendo humano, e por isso cada assinatura
 * volta com a URL da tela de pagamento dela.
 *
 * O vínculo aqui é direto: o orderNo vem na resposta, então não depende da
 * reconciliação por varredura — que segue existindo para as compras feitas
 * fora do sistema.
 */
async function comprarPeloConsole(db, pedido, itens) {
  const consoleApi = require('./nicsrs-console-client');
  const deps = { getConfig, setConfig };
  const criadas = [];
  const falhas = [];

  for (const item of itens) {
    const prod = db.prepare(
      'SELECT code, productName, vendor, consoleProductId, consolePeriodType FROM ssl_produtos_nicsrs WHERE produtoId = ?'
    ).get(item.produtoId);
    if (!prod) continue;

    // Resolve o id do painel uma vez por produto e guarda.
    let productId = prod.consoleProductId;
    let periodType = prod.consolePeriodType || 2;
    if (!productId) {
      try {
        const cfg = await consoleApi.configDoProduto(db, deps, prod.code);
        productId = cfg.productId;
        periodType = cfg.periodType || 2;
        if (productId) {
          db.prepare('UPDATE ssl_produtos_nicsrs SET consoleProductId = ?, consolePeriodType = ? WHERE code = ?')
            .run(productId, periodType, prod.code);
        }
      } catch (err) {
        falhas.push({ productCode: prod.code, erro: `não foi possível resolver o produto no painel: ${err.message}` });
        continue;
      }
    }
    if (!productId) {
      falhas.push({ productCode: prod.code, erro: 'produto sem id no painel da NicSRS' });
      continue;
    }

    const unidades = Math.max(1, Math.round(Number(item.quantidade) || 1));
    const anos = Number(item.anos) || 1;
    for (let i = 0; i < unidades; i++) {
      const refId = `LA-PC${pedido.id}-I${item.id}-${i + 1}`;
      // Registra ANTES de chamar: se a resposta se perder, a intenção fica.
      try {
        db.prepare(`
          INSERT INTO ssl_pedidos_nicsrs
            (pedidoCompraId, contratoItemId, productCode, productName, vendor, anos,
             valorBrl, status, refId, dataCompra, observacoes)
          VALUES (?,?,?,?,?,?,?, 'comprando', ?, ?, ?)
          ON CONFLICT(refId) DO NOTHING
        `).run(pedido.id, pedido.contratoItemId || null, prod.code, prod.productName, prod.vendor,
               anos, Number(item.custoUnitario) || null, refId, hojeIso(),
               `Pedido de compra ${pedido.numero} · unidade ${i + 1}/${unidades}`);
      } catch (err) {
        falhas.push({ refId, erro: err.message });
        continue;
      }
      const reg = db.prepare('SELECT id, orderNum FROM ssl_pedidos_nicsrs WHERE refId = ?').get(refId);
      if (reg && reg.orderNum) continue;              // já criada num envio anterior

      try {
        const r = await consoleApi.criarOrdem(db, deps, {
          productId, quantidade: 1, periodos: anos, periodType,
        });
        db.prepare(`
          UPDATE ssl_pedidos_nicsrs SET
            orderNum = ?, status = 'aguardando-pagamento', ultimoErro = NULL,
            dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(r.orderNo, reg.id);
        criadas.push({ refId, orderNo: r.orderNo, urlPagamento: r.urlPagamento,
                       productCode: prod.code, productName: prod.productName, anos });
      } catch (err) {
        db.prepare("UPDATE ssl_pedidos_nicsrs SET status = 'erro', ultimoErro = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?")
          .run(err.message, reg.id);
        falhas.push({ refId, erro: err.message });
      }
    }
  }

  return {
    modo: 'console',
    resumo: criadas.length
      ? `${criadas.length} pedido(s) criado(s) na NicSRS — falta pagar`
      : 'nenhum pedido criado',
    criadas, compradas: [], falhas,
    parcial: criadas.length > 0 && falhas.length > 0,
    nenhuma: criadas.length === 0,
  };
}

/**
 * Liga o que foi comprado no painel ao pedido de compra que o originou.
 *
 * A assinatura só aparece em /ssl/list DEPOIS de paga (conferido em 2026-08-29:
 * a ordem não paga não vem, e a paga aparece em segundos já com o orderNum).
 * Como o orderNum é gerado pela NicSRS, o elo não pode ser combinado antes — é
 * por isso que a reconciliação existe em vez de um refId nosso.
 *
 * Casa por productCode, e só quando não há ambiguidade: com duas assinaturas
 * pendentes do mesmo produto e uma compra nova, não há como saber qual é qual —
 * nesse caso devolve o candidato para alguém decidir, em vez de chutar.
 */
function reconciliarComprasNicsrs(db, lista) {
  const vinculados = [];
  const ambiguos = [];

  // orderNums que já pertencem a alguém. Inclui os de ssl_certificados: a
  // importação traz o histórico inteiro da conta sem criar linha em
  // ssl_pedidos_nicsrs, então sem isto TODA compra antiga apareceria como
  // "sem vínculo" e disputaria uma pendência nova.
  const usados = new Set([
    ...db.prepare("SELECT orderNum FROM ssl_pedidos_nicsrs WHERE orderNum IS NOT NULL AND orderNum <> ''")
      .all().map(r => r.orderNum),
    ...db.prepare("SELECT orderNum FROM ssl_certificados WHERE orderNum IS NOT NULL AND orderNum <> ''")
      .all().map(r => r.orderNum),
  ]);

  for (const c of lista) {
    const orderNum = c.orderNum && c.orderNum !== 'undefined' ? String(c.orderNum) : null;
    if (!orderNum || usados.has(orderNum)) continue;

    // A compra tem de ser POSTERIOR à pendência. Sem isto, uma assinatura de
    // meses atrás — que existe na conta e ainda não tem linha aqui — casaria
    // com um pedido criado hoje só por serem do mesmo produto. Medido contra a
    // conta 1bit: 6 compras antigas disputavam uma única pendência nova.
    const criadaEm = c.created ? String(c.created).slice(0, 19) : null;
    if (!criadaEm) continue;                      // sem data não dá para afirmar nada

    // Pedido cancelado não pode receber compra: a pendência dele é resíduo, e
    // vincular ali daria a uma compra nova o destino de um pedido que já foi
    // descartado. LEFT JOIN porque a assinatura pode não ter pedido nenhum.
    const candidatos = db.prepare(`
      SELECT s.* FROM ssl_pedidos_nicsrs s
      LEFT JOIN pedidos_compra p ON p.id = s.pedidoCompraId
      WHERE s.status = 'aguardando-compra' AND (s.orderNum IS NULL OR s.orderNum = '')
        AND s.productCode = ?
        AND (p.id IS NULL OR p.status NOT IN ('cancelado'))
        AND datetime(?) >= datetime(s.dataCriacao)
      ORDER BY s.id
    `).all(c.productCode || '', criadaEm);

    if (!candidatos.length) continue;
    if (candidatos.length > 1) {
      ambiguos.push({ orderNum, productCode: c.productCode, candidatos: candidatos.map(x => x.refId) });
      continue;
    }

    const alvo = candidatos[0];
    db.prepare(`
      UPDATE ssl_pedidos_nicsrs SET
        orderNum = ?, certIdAssinatura = ?, status = 'aguardando-dados',
        valorUsd = COALESCE(valorUsd, ?), dataCompra = COALESCE(dataCompra, ?),
        ultimoErro = NULL, dataAtualizacao = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(orderNum, c.certId ? String(c.certId) : null,
           c.amount != null ? Number(c.amount) : null,
           c.created ? String(c.created).slice(0, 10) : null, alvo.id);
    usados.add(orderNum);
    vinculados.push({ orderNum, refId: alvo.refId, pedidoCompraId: alvo.pedidoCompraId, certId: c.certId });
  }

  return { vinculados, ambiguos };
}

/**
 * Certificados que pertencem a um pedido de compra.
 *
 * São dois caminhos porque existem dois fluxos de compra, e eles amarram o
 * pedido em lugares diferentes:
 *
 *   A) o certificado guarda `pedidoCompraId` ele mesmo. Nasce do vínculo
 *      manual (`/vincular-pedido-compra`) e dos registros anteriores à
 *      remoção da rota que criava o pedido a partir do certificado.
 *   B) comprarAssinaturasDoPedido — o pedido vem de um item de CONTRATO, cria
 *      uma assinatura (`ssl_pedidos_nicsrs`) por unidade, e o certificado só
 *      conhece `pedidoNicsrsId`. O pedido de compra fica na assinatura.
 *
 * Ignorar o caminho B foi o que deixou o CREADF com o pedido em aberto mesmo
 * depois de o certificado sair.
 */
function certificadosDoPedidoCompra(db, pedidoCompraId) {
  return db.prepare(`
    SELECT DISTINCT c.* FROM ssl_certificados c
    LEFT JOIN ssl_pedidos_nicsrs p ON p.id = c.pedidoNicsrsId
    WHERE c.pedidoCompraId = ? OR p.pedidoCompraId = ?
  `).all(pedidoCompraId, pedidoCompraId);
}

/**
 * Fecha o pedido de compra quando os certificados que ele pagou já saíram.
 *
 * Chamado na transição para 'emitido' — e SÓ nela. A importação não passa por
 * aqui de propósito: ela traz o histórico inteiro da conta e fecharia pedidos
 * antigos retroativamente.
 *
 * O que este fechamento NÃO faz, e por quê:
 *   - não gera movimentação de estoque. Certificado é serviço (tipoProduto
 *     SERVICO); a rota /receber geraria entrada de estoque de algo que não tem
 *     saldo. Nenhum produto de serviço movimenta estoque neste sistema.
 *   - não lança contas a pagar. A despesa da NicSRS entra por
 *     lancarComprasNoFinanceiro, que é idempotente pelo orderNum; lançar aqui
 *     duplicaria.
 *
 * Pedido misto (certificado + material) fica 'recebido_parcial': só os itens
 * NicSRS são baixados, o resto continua esperando o recebimento normal.
 *
 * Devolve null quando não havia o que fazer.
 */
function fecharPedidoCompraSeEmitido(db, cert, usuario = 'scheduler') {
  let pedidoCompraId = cert.pedidoCompraId || null;
  if (!pedidoCompraId && cert.pedidoNicsrsId) {
    const p = db.prepare('SELECT pedidoCompraId FROM ssl_pedidos_nicsrs WHERE id = ?').get(cert.pedidoNicsrsId);
    pedidoCompraId = p && p.pedidoCompraId ? p.pedidoCompraId : null;
  }
  if (!pedidoCompraId) return null;

  const pedido = db.prepare('SELECT * FROM pedidos_compra WHERE id = ?').get(pedidoCompraId);
  if (!pedido) return null;
  // 'rascunho' nunca foi transmitido e 'cancelado' foi descartado — fechar
  // qualquer um dos dois seria inventar um recebimento. 'recebido' já está.
  if (!['enviado', 'enviado_parcial', 'recebido_parcial'].includes(pedido.status)) return null;

  // Uma assinatura por unidade: enquanto faltar certificado do mesmo pedido,
  // ele não está atendido.
  const irmaos = certificadosDoPedidoCompra(db, pedidoCompraId);
  const pendentes = irmaos.filter(c => c.status !== 'emitido');
  if (pendentes.length) {
    return { pedidoCompraId, fechado: false, faltam: pendentes.length };
  }

  const hoje = hojeIso();
  let novoStatus = pedido.status;
  db.transaction(() => {
    // Só os itens que são produto NicSRS.
    db.prepare(`
      UPDATE pedido_compra_itens
         SET quantidadeRecebida = quantidade
       WHERE pedidoCompraId = ?
         AND produtoId IN (SELECT produtoId FROM ssl_produtos_nicsrs)
    `).run(pedidoCompraId);

    // Mesma regra do recebimento manual (compras-routes.js): tudo baixado vira
    // 'recebido', parte vira 'recebido_parcial'.
    const itens = db.prepare(
      'SELECT quantidade, quantidadeRecebida FROM pedido_compra_itens WHERE pedidoCompraId = ?'
    ).all(pedidoCompraId);
    const todos = itens.every(i => i.quantidadeRecebida >= i.quantidade - 0.001);
    novoStatus = todos ? 'recebido' : 'recebido_parcial';

    db.prepare(`
      UPDATE pedidos_compra
         SET status = ?, dataRecebimento = COALESCE(dataRecebimento, ?), dataAtualizacao = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(novoStatus, todos ? hoje : null, pedidoCompraId);
  })();

  for (const c of irmaos) {
    registrarEvento(db, c.id, 'pedido-compra',
      `Pedido de compra ${pedido.numero} marcado como ${novoStatus}: certificado emitido`,
      { pedidoCompraId, status: novoStatus }, usuario);
  }
  return { pedidoCompraId, numero: pedido.numero, fechado: true, status: novoStatus };
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
  const campos = {
    organation: p.razaoSocial || '',      // grafia da NicSRS, ver paraContatoNicsrs
    address: logradouro,
    city: p.cidade || '',
    province: p.uf || '',
    country: 'BR',
    postCode: (p.cep || '').replace(/\D/g, ''),
    phone: (p.telefone || '').replace(/\D/g, ''),
    idNumber: (p.cpfCnpj || '').replace(/\D/g, ''),
  };

  // Campo vazio NÃO viaja.
  //
  // Foi o que recusou a compra do #61 duas vezes em 16/09/2026. O cadastro do
  // MUNICIPIO DE SAO BERNARDO não tem telefone, e ia `phone: ''` no payload; a
  // NicSRS trata o bloco da organização como inválido e reporta isso como
  // "organizationInfo: organizationInfo is required" — uma mensagem que não tem
  // relação visível com a causa e custou duas idas à API para ser isolada.
  //
  // A compra equivalente que deu certo (#43, CREA-DF, mesmo produto Certum OV)
  // só diferia nisto: tinha telefone cadastrado. Omitir o que está em branco é
  // o mesmo princípio de mesclarContato — string vazia é ausência de dado, e
  // ausência se representa não mandando a chave.
  for (const [k, v] of Object.entries(campos)) {
    if (!String(v || '').trim()) delete campos[k];
  }
  return campos;
}

/** Contato gravado no certificado, ou null. Não decide fallback — quem compõe
 *  é mesclarContato(), porque o que falta aqui tem de vir de algum lugar. */
function contatoGravado(cert, papel) {
  const bruto = cert && cert[papel];
  if (!bruto) return null;
  try {
    const c = JSON.parse(bruto);
    // Basta UM campo preenchido. Era `c.email || c.firstName`, e isso
    // descartava o contato inteiro quando faltavam os dois — foi o que mandou o
    // pedido do #71 (gaif.mpsc.mp.br, contrato CT-2026-0006) com TODOS os
    // campos do tenant, apesar de o certificado ter organização, endereço,
    // cidade, CEP e telefone do Ministério Público gravados. O bloco "Dados da
    // organização" preenche justamente esses campos, e nenhum deles é `email`
    // ou `firstName`: o que a tela mostrava salvo, o payload ignorava.
    //
    // Quem completa o que falta é mesclarContato; aqui só se decide se há algo
    // a aproveitar.
    if (c && typeof c === 'object' && Object.values(c).some((v) => String(v || '').trim())) {
      return paraContatoNicsrs(c);
    }
  } catch (_) { /* JSON torto: trata como ausente */ }
  return null;
}

/**
 * Contato específico SOBRE o do tenant — mescla, não substituição.
 *
 * Era substituição, e foi o que quebrou a compra do #61 em 15/09/2026. O
 * certificado tinha contato do cliente com cinco campos (nome, email, celular,
 * cargo) e ele VENCIA inteiro o contato do tenant, que é o único lugar com
 * `organation`, `address`, `city`, `state`, `postCode` e `country`. Num produto
 * DV isso passa; num OV a NicSRS recusa o pedido com "The administrator's
 * organation is required" — e repete a queixa para tech e finance, porque os
 * três papéis caem no mesmo contato.
 *
 * Que era substituição só apareceu agora porque, até o #61, TODO certificado OV
 * desta conta tinha o campo de contato vazio e caía direto no contato do
 * tenant. O primeiro que preencheu foi o primeiro a falhar.
 *
 * Campo vazio não sobrescreve: string em branco vinda de um formulário é
 * ausência de dado, não decisão de apagar.
 */
function mesclarContato(base, especifico) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(especifico || {})) {
    if (v !== null && v !== undefined && String(v).trim() !== '') out[k] = v;
  }
  return out;
}

function paraContatoNicsrs(contato) {
  if (!contato || typeof contato !== 'object') return contato;
  const { organization, organation, ...resto } = contato;
  return { ...resto, organation: organation || organization || '' };
}

// Campos que a NicSRS exige de CADA contato num produto OV/EV. A lista é a
// própria mensagem de recusa dela, nos nomes dela: `organation` é assim mesmo,
// sem o "iz" (ver paraContatoNicsrs).
const CAMPOS_CONTATO_OV = ['organation', 'address', 'city', 'state', 'postCode', 'country'];
const ROTULO_CAMPO = {
  organation: 'organização', address: 'endereço', city: 'cidade',
  state: 'estado/UF', postCode: 'CEP', country: 'país',
};
const ROTULO_ORG = {
  organizationName: 'razão social', organizationAddress: 'endereço',
  organizationCity: 'cidade', organizationCountry: 'país',
  organizationPostCode: 'CEP', organizationMobile: 'telefone',
};

/**
 * Contatos completos o bastante para um OV/EV, ANTES de ir à NicSRS.
 *
 * Existe porque a recusa de lá é cara e ilegível: volta como `-1` com seis
 * queixas repetidas três vezes ("The administrator's organation is required,
 * The administrator's postCode is required…"), sem dizer em que tela resolver.
 * Aqui o erro chega nomeando o papel, o campo em português e onde preencher.
 *
 * DV não entra: a CA não valida organização nenhuma, e exigir endereço num DV
 * bloquearia compra que a NicSRS aceita sem reclamar.
 */
function erroDadosOv(params, validationType) {
  if (!['ov', 'ev'].includes(String(validationType || '').toLowerCase())) return null;

  const papeis = [['Administrator', 'administrativo'], ['tech', 'técnico'], ['finance', 'financeiro']];
  const faltas = [];
  for (const [chave, rotulo] of papeis) {
    const c = params[chave] || {};
    const faltando = CAMPOS_CONTATO_OV.filter((k) => !String(c[k] || '').trim());
    if (faltando.length) faltas.push(`${rotulo} (${faltando.map((k) => ROTULO_CAMPO[k]).join(', ')})`);
  }
  if (faltas.length) {
    return `Este produto é de validação de organização (${String(validationType).toUpperCase()}) e a NicSRS exige`
      + ` endereço completo nos três contatos. Falta preencher: ${faltas.join('; ')}.`
      + ` Complete em "Dados da organização" na edição do certificado, ou no contato administrativo do tenant.`;
  }

  // O bloco da organização é exigência separada dos contatos, e some da conta
  // se o certificado não tiver cliente vinculado — daí a mensagem apontar o
  // cadastro do cliente, e não a tela do certificado.
  const info = params.organizationInfo;
  const faltandoOrg = !info ? CAMPOS_ORGANIZATION_INFO
    : CAMPOS_ORGANIZATION_INFO.filter((k) => !String(info[k] || '').trim());
  if (faltandoOrg.length) {
    return `Este produto é ${String(validationType).toUpperCase()} e a NicSRS exige os dados da organização`
      + ` (${faltandoOrg.map((k) => ROTULO_ORG[k]).join(', ')}).`
      + ` Eles vêm do cadastro do cliente — vincule o cliente ao certificado e complete o cadastro dele.`;
  }
  return null;
}

/**
 * Curinga do domínio contra o que o produto aceita.
 *
 * Vale a checagem local porque o erro equivalente da NicSRS é caro: chega
 * depois da ida à API e com o texto dela ("The product does not support normal
 * type(1BIT.NET.BR)"), que não diz o que fazer. Só opina quando o catálogo tem
 * a informação — produto sem `supportStandard` gravado passa direto, e quem
 * decide é a NicSRS.
 */
function erroDominioProduto(prod, commonName) {
  const dom = String(commonName || '').trim().toLowerCase();
  if (!prod || !dom) return null;
  const nome = prod.productName || prod.code;
  const ehWildcard = dom.startsWith('*.');
  if (ehWildcard && prod.supportWildcard === 'N') {
    const sugestao = dom.slice(2);
    return { mensagem: `${nome} não emite para domínio curinga — use "${sugestao}" (sem o "*.")`, sugestao };
  }
  if (!ehWildcard && prod.supportStandard === 'N') {
    const sugestao = `*.${dom}`;
    return { mensagem: `${nome} só emite para domínio curinga — use "${sugestao}"`, sugestao };
  }
  return null;
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
  // O contato do certificado diz QUEM é a pessoa; o do tenant completa o
  // endereço e a organização que a CA valida num OV/EV. Mesclado nessa ordem, o
  // específico vence campo a campo sem levar junto os buracos.
  const admin = mesclarContato(padrao, contatoGravado(cert, 'contatoAdmin'));
  const params = {
    // Sem CSR a NicSRS gera o par de chaves ela mesma (system-generated) e a
    // compra passa igual — comprovado em 2026-09-01. Mandar `csr: null` seria
    // diferente de omitir, então o campo só entra quando há CSR de verdade.
    ...(cert.csr ? { csr: cert.csr } : {}),
    // Códigos do apêndice "Server Platforms", em minúsculas: nginx, apache2,
    // iis7, other… "NGINX" não é aceito.
    server: normalizarServidor(cert.servidor),
    domainInfo,
    Administrator: admin,
    // Sobre `admin`, e não sobre `padrao`: sem contato próprio, tech e finance
    // seguem sendo o administrativo, como sempre foram.
    tech: mesclarContato(admin, contatoGravado(cert, 'contatoTecnico')),
    finance: mesclarContato(admin, contatoGravado(cert, 'contatoFinanceiro')),
  };

  // Organização validada pela CA num OV/EV: o cliente do contrato, dono do
  // domínio. Vai do cadastro dele, não de cópia guardada no certificado.
  // A organização do cliente NÃO vai solta na raiz do payload.
  //
  // Ia, desde 181c65f (24/08/2026), e isso recusou a compra do #61 quatro vezes
  // em 15-16/09 com "organizationInfo: organizationInfo is required" — uma
  // mensagem que não menciona a raiz e mandou a investigação para o lado errado
  // (contatos, depois telefone em branco). Ao ver `organation` avulso, a NicSRS
  // passa a cobrar o bloco `organizationInfo` formal.
  //
  // O assign nunca funcionou: de 24/08 até hoje, nenhum certificado COM cliente
  // vinculado foi comprado. As cinco compras OV que deram certo nesse período
  // (#46, #54, #55, #56, #60) tinham `clienteId` vazio, então `org` era null e
  // nada era espalhado. O #43, que tinha cliente, é de 21/08 — anterior ao
  // commit que introduziu isto.
  //
  // E não faz falta: a organização impressa no certificado vem da validação que
  // a CA faz do domínio, não do que mandamos. O #46 foi emitido com
  // `O = TRIBUNAL REGIONAL ELEITORAL DE MINAS GERAIS` sem enviar organização
  // alguma. `organizacaoDoCliente` segue viva para preencher os CONTATOS pela
  // tela, que é onde a NicSRS de fato lê esses dados.
  if (cert.uniqueValue) params.uniqueValue = cert.uniqueValue;

  // `organizationInfo` — obrigatório em OV/EV, com nomes PRÓPRIOS de campo.
  //
  // Os seis campos têm prefixo `organization` e NÃO são os mesmos dos contatos:
  // lá é `organation`/`city`/`state`, aqui é `organizationName`/
  // `organizationCity`/`organizationAddress`/`organizationCountry`/
  // `organizationPostCode`/`organizationMobile`. Confundir os dois conjuntos foi
  // o que travou a compra do #61 por seis tentativas em 15-16/09/2026.
  //
  // Como a lista foi obtida, porque a documentação não a traz: mandando um
  // objeto QUALQUER não-vazio (`{x:1}`), a NicSRS troca o "organizationInfo is
  // required" genérico por uma recusa que NOMEIA cada campo que falta. Bloco
  // vazio (`{}`) ela trata como ausente e não diz nada — foi por isso que
  // deduzir do `applyParams` do /ssl/collect não levou a lugar nenhum: o `{}`
  // que aparece lá é normalização da RESPOSTA, não o que foi enviado.
  //
  // Com os seis preenchidos, a resposta saiu de -1 (falha de validação) para
  // -2, ou seja: o payload passou a ser aceito.
  const orgInfo = organizationInfo || organizationInfoDoCliente(db, cert.clienteId);
  if (orgInfo) params.organizationInfo = orgInfo;
  return params;
}

// Campos que a NicSRS exige dentro de `organizationInfo`, nos nomes dela.
const CAMPOS_ORGANIZATION_INFO = ['organizationName', 'organizationAddress', 'organizationCity',
                                  'organizationCountry', 'organizationPostCode', 'organizationMobile'];

/**
 * `organizationInfo` a partir do cadastro do cliente.
 *
 * Devolve null quando o cliente não está vinculado ou quando falta algum dos
 * seis campos: bloco incompleto é recusado do mesmo jeito que bloco ausente, e
 * mandá-lo pela metade só troca uma recusa por outra. Quem avisa o que falta,
 * em português e antes da ida à API, é `erroOrganizationInfoOv`.
 */
function organizationInfoDoCliente(db, clienteId) {
  const org = organizacaoDoCliente(db, clienteId);
  if (!org) return null;
  const info = {
    organizationName:     org.organation,
    organizationAddress:  org.address,
    organizationCity:     org.city,
    organizationCountry:  org.country || 'BR',
    organizationPostCode: org.postCode,
    organizationMobile:   org.phone,
  };
  // Mesmo princípio de organizacaoDoCliente: campo vazio não viaja.
  for (const [k, v] of Object.entries(info)) {
    if (!String(v || '').trim()) delete info[k];
  }
  return CAMPOS_ORGANIZATION_INFO.every((k) => info[k]) ? info : null;
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
          // Sessão do painel: o refresh token NUNCA sai daqui — só se ele
          // existe e quando vence, que é o que a tela precisa mostrar.
          modoCompra: modoCompra(db),
          consoleSessaoConfigurada: !!getConfig(db, 'nicsrs_console_refresh_token'),
          consoleSessaoExpiraEm: expiracaoRefreshConsole(db),
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

      // Sessão do painel (modo 'console'). Validada antes de gravar pelo mesmo
      // motivo do token: um refresh inválido derruba a compra em silêncio, e o
      // erro só apareceria no próximo pedido.
      const { consoleRefreshToken, modoCompra: modoNovo } = req.body;
      if (consoleRefreshToken !== undefined && String(consoleRefreshToken || '').trim()) {
        const novo = String(consoleRefreshToken).trim();
        const anterior = getConfig(db, 'nicsrs_console_refresh_token');
        setConfig(db, 'nicsrs_console_refresh_token', novo);
        try {
          const consoleApi = require('./nicsrs-console-client');
          consoleApi.limparCache();
          await consoleApi.testarSessao(db, { getConfig, setConfig });
        } catch (err) {
          // Desfaz: melhor manter a sessão antiga (que pode estar viva) do que
          // trocar por uma que não funciona.
          if (anterior) setConfig(db, 'nicsrs_console_refresh_token', anterior);
          else setConfig(db, 'nicsrs_console_refresh_token', '');
          return res.status(400).json({ success: false,
            error: `Sessão do painel recusada, nada foi alterado: ${err.message}` });
        }
      }
      if (modoNovo !== undefined && ['painel', 'console', 'api'].includes(modoNovo)) {
        setConfig(db, 'nicsrs_modo_compra', modoNovo);
      }
      logAction(db, req, 'configurar', 'ssl-nicsrs', null, {
        apiToken: apiToken ? '(alterado)' : undefined,
        consoleRefreshToken: consoleRefreshToken ? '(alterado)' : undefined,
        modoCompra: modoNovo,
      });
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
   * Sincronização que a tela dispara sozinha ao abrir.
   *
   * É a importação SEM collect: uma única chamada (`ssl/list`) em vez de uma
   * por certificado vivo — 30 requisições viravam 1. O que a tela precisa
   * mostrar (compra nova, orderNum, certId, status, domínio) vem todo do list;
   * o collect só acrescenta CSR, DCV e a data do arquivo, que interessam ao
   * reissue e continuam vindo do botão manual e do ciclo de 12h.
   *
   * O intervalo mínimo existe porque isto dispara por ABERTURA de página: sem
   * ele, um F5 repetido — ou cinco usuários com a tela aberta — vira rajada
   * contra a NicSRS por nada. O carimbo é gravado ANTES da chamada, de
   * propósito: duas abas abrindo juntas fariam duas importações simultâneas se
   * o carimbo só fosse gravado no fim. E falha não regrava — se a NicSRS estiver
   * fora, o próximo tenta daqui a JANELA, em vez de martelar a cada abertura.
   *
   * Nunca é erro para o usuário: a tela funciona lendo o banco, e esta rota é
   * um extra. Sem token configurado, devolve `pulou` e pronto.
   */
  const SYNC_AUTO_JANELA_MS = 5 * 60 * 1000;

  app.post('/api/ssl/certificados/sincronizar-auto', async (req, res) => {
    try {
      const token = getConfig(db, 'nicsrs_api_token');
      if (!token) return res.json({ success: true, pulou: true, motivo: 'sem token' });

      const ultima = Number(getConfig(db, 'nicsrs_sync_auto_em', '0')) || 0;
      const desde = Date.now() - ultima;
      if (desde < SYNC_AUTO_JANELA_MS) {
        return res.json({ success: true, pulou: true, motivo: 'recente',
          faltamSegundos: Math.ceil((SYNC_AUTO_JANELA_MS - desde) / 1000) });
      }
      setConfig(db, 'nicsrs_sync_auto_em', String(Date.now()));

      const resumo = await importarDaNicsrs(db, token, { comCollect: false });
      // Só registra na auditoria quando trouxe algo novo: uma linha a cada
      // abertura de tela afogaria o audit_log sem contar nada.
      if (resumo.criados > 0) {
        logAction(db, req, 'sincronizar-auto', 'ssl-certificado', null, resumo);
      }
      res.json({ success: true, pulou: false, ...resumo });
    } catch (err) {
      // 200 de propósito: a tela não deve mostrar erro vermelho porque um
      // extra falhou. O motivo vai no corpo para quem quiser depurar.
      res.json({ success: false, pulou: false, error: err.message });
    }
  });

  /**
   * Compras da NicSRS que não pertencem a pedido de compra nenhum.
   *
   * Alimenta o vínculo manual. Existe porque a reconciliação automática tem um
   * ponto cego estrutural: ela ignora todo `orderNum` que já apareça em
   * `ssl_certificados`, e a importação preenche exatamente esse campo. Ou seja,
   * quem importa antes de o ciclo rodar perde a chance do vínculo automático
   * para sempre — e não havia como refazê-lo pela tela.
   */
  app.get('/api/ssl/compras-sem-vinculo', (req, res) => {
    try {
      const compras = db.prepare(`
        SELECT c.id, c.commonName, c.productCode, c.productName, c.orderNum, c.certId,
               c.custoUsd, c.dataCompra, c.status
        FROM ssl_certificados c
        LEFT JOIN ssl_pedidos_nicsrs sn ON sn.id = c.pedidoNicsrsId
        WHERE c.pedidoCompraId IS NULL
          AND (sn.id IS NULL OR sn.pedidoCompraId IS NULL)
          AND c.status NOT IN ('cancelado', 'expirado', 'substituido')
          AND c.orderNum IS NOT NULL AND c.orderNum <> ''
        ORDER BY c.dataCompra DESC, c.id DESC
      `).all();
      res.json({ success: true, compras });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Amarra uma compra já feita na NicSRS a um pedido de compra, à mão.
   *
   * Faz o MESMO que a reconciliação faria: quando o pedido tem uma assinatura
   * esperando (`aguardando-compra`), é ela que recebe o `orderNum` — não o
   * certificado. Escrever direto em `ssl_certificados.pedidoCompraId` nesse caso
   * deixaria a assinatura pendente para sempre, e o pedido nunca fecharia
   * sozinho quando o certificado saísse.
   *
   * Sem assinatura esperando (compra avulsa, pedido de material misto), cai no
   * vínculo direto.
   */
  app.post('/api/ssl/certificados/:id/vincular-pedido-compra', (req, res) => {
    try {
      const cert = db.prepare('SELECT * FROM ssl_certificados WHERE id = ?').get(Number(req.params.id));
      if (!cert) return res.status(404).json({ success: false, error: 'Certificado não encontrado' });

      const pedidoCompraId = Number(req.body.pedidoCompraId);
      const pedido = db.prepare('SELECT * FROM pedidos_compra WHERE id = ?').get(pedidoCompraId);
      if (!pedido) return res.status(400).json({ success: false, error: 'Pedido de compra não encontrado' });
      if (pedido.status === 'cancelado') {
        return res.status(409).json({ success: false,
          error: `O pedido ${pedido.numero} está cancelado — vincular ali daria a esta compra o destino de um pedido descartado` });
      }
      if (cert.pedidoCompraId || cert.pedidoNicsrsId) {
        return res.status(409).json({ success: false,
          error: 'Este certificado já está vinculado a um pedido' });
      }

      // Assinatura esperando neste pedido, do mesmo produto. O productCode é
      // conferido porque vincular produto trocado é o erro que a reconciliação
      // automática se recusa a cometer — o manual não deve ser mais frouxo por
      // ser manual; só mais explícito sobre o motivo.
      const esperando = db.prepare(`
        SELECT * FROM ssl_pedidos_nicsrs
        WHERE pedidoCompraId = ? AND status = 'aguardando-compra'
          AND (orderNum IS NULL OR orderNum = '')
        ORDER BY id
      `).all(pedidoCompraId);
      const assinatura = esperando.find(a => a.productCode === cert.productCode);

      // O pedido espera assinatura, mas de OUTRO produto. Cair no vínculo
      // direto aqui seria o pior dos mundos: a compra ganharia dono, a
      // assinatura ficaria `aguardando-compra` para sempre e o pedido nunca
      // fecharia. Recusar e dizer o que não bate deixa a escolha com quem sabe
      // — comprar o produto certo, ou corrigir o item do pedido.
      if (!assinatura && esperando.length) {
        return res.status(409).json({ success: false,
          error: `O pedido ${pedido.numero} espera "${esperando[0].productName || esperando[0].productCode}"`
            + ` e esta compra é "${cert.productName || cert.productCode}".`
            + ` Vincular assim deixaria o pedido aberto para sempre.` });
      }

      if (assinatura) {
        db.prepare(`
          UPDATE ssl_pedidos_nicsrs SET
            orderNum = ?, certIdAssinatura = ?, status = 'aguardando-dados',
            valorUsd = COALESCE(valorUsd, ?), dataCompra = COALESCE(dataCompra, ?),
            ultimoErro = NULL, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(cert.orderNum, cert.certId, cert.custoUsd, cert.dataCompra, assinatura.id);
        db.prepare('UPDATE ssl_certificados SET pedidoNicsrsId = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
          .run(assinatura.id, cert.id);
      } else {
        db.prepare('UPDATE ssl_certificados SET pedidoCompraId = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
          .run(pedidoCompraId, cert.id);
      }

      const via = assinatura ? `assinatura ${assinatura.refId}` : 'vínculo direto';
      registrarEvento(db, cert.id, 'vinculo-pedido',
        `Vinculado à mão ao pedido ${pedido.numero} (${via})`, null, req.user?.username);
      logAction(db, req, 'vincular-pedido-compra', 'ssl-certificado', cert.id,
        { pedidoCompraId, numero: pedido.numero, orderNum: cert.orderNum, via });

      res.json({ success: true, pedido: pedido.numero, via,
        assinaturaId: assinatura ? assinatura.id : null });
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
  /**
   * Organização do cliente no formato que a NicSRS espera, para o botão
   * "Preencher com os dados do cliente" da tela.
   *
   * Existe para que ninguém redigite endereço que já está no cadastro: dado
   * redigitado diverge, e num OV/EV divergir da razão social registrada é o
   * tipo de detalhe que a CA recusa depois de a compra já estar paga.
   */
  app.get('/api/ssl/organizacao-cliente/:clienteId', (req, res) => {
    try {
      const org = organizacaoDoCliente(db, Number(req.params.clienteId));
      if (!org) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
      // `state` é o nome que a NicSRS usa nos contatos; organizacaoDoCliente
      // devolve `province`, que é o nome dela no bloco da organização. Sem UF
      // cadastrada a chave não entra — ver o porquê em organizacaoDoCliente.
      res.json({ success: true, organizacao: org.province ? { ...org, state: org.province } : { ...org } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Contato do cliente no formato que a CA pede, para o botão "Preencher com os
   * dados do cliente" do bloco de contatos.
   *
   * Fonte preferida é `pessoas_contatos` (a pessoa de verdade, com nome e
   * cargo); sem ela, cai para o e-mail e o telefone do próprio cadastro. O
   * `faltando` volta junto porque a CA exige nome, sobrenome e e-mail — e é
   * melhor a tela dizer o que falta ANTES da compra do que a NicSRS recusar
   * depois. Hoje `pessoas_contatos` está vazia em todos os clientes.
   */
  app.get('/api/ssl/contato-cliente/:clienteId', (req, res) => {
    try {
      const clienteId = Number(req.params.clienteId);
      const p = db.prepare('SELECT razaoSocial, email, telefone, celular FROM pessoas WHERE id = ?').get(clienteId);
      if (!p) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });

      let c = null;
      try {
        c = db.prepare(`
          SELECT nome, cargo, email, telefone, celular FROM pessoas_contatos
          WHERE pessoaId = ? AND ativo = 1 ORDER BY principal DESC, id LIMIT 1
        `).get(clienteId);
      } catch (_) { /* base sem a tabela: segue com o cadastro da pessoa */ }

      const nome = String((c && c.nome) || '').trim();
      const i = nome.indexOf(' ');
      const contato = {
        firstName: i > 0 ? nome.slice(0, i) : nome,
        lastName:  i > 0 ? nome.slice(i + 1).trim() : '',
        job:       (c && c.cargo) || '',
        email:     (c && c.email) || p.email || '',
        mobile:    (c && (c.celular || c.telefone)) || p.celular || p.telefone || '',
      };
      for (const [k, v] of Object.entries(contato)) {
        if (!String(v || '').trim()) delete contato[k];
      }
      const faltando = ['firstName', 'lastName', 'email'].filter((k) => !contato[k]);
      res.json({ success: true, contato, faltando, origem: c ? 'contato cadastrado' : 'dados do cliente' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

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

  /**
   * A consulta que alimenta o grid E o relatório. Extraída porque os dois
   * precisam responder à mesma pergunta: filtro que mudar aqui vale nos dois
   * lugares, e é o que impede o .xlsx de listar um conjunto diferente do que
   * está na tela de quem o pediu.
   *
   * `limit: null` desliga o corte — é o caso do relatório, onde o teto de 200
   * da tela esconderia linhas que o filtro pediu.
   */
  function consultarCertificados({ contratoId, clienteId, status, q, limit }) {
    // O pedido de compra chega por DOIS caminhos, pelo mesmo motivo explicado
    // em certificadosDoPedidoCompra(): quando o certificado nasce primeiro ele
    // guarda `pedidoCompraId`; quando a compra vem de um item de contrato,
    // quem guarda é a assinatura (`ssl_pedidos_nicsrs`). Olhar só o primeiro
    // é o que fazia o CREADF parecer não ter pedido nenhum.
    let sql = `
      SELECT s.*, p.razaoSocial AS clienteNome, c.numero AS contratoNumero,
             COALESCE(pc.id, pcn.id)         AS pedidoCompraIdEfetivo,
             COALESCE(pc.numero, pcn.numero) AS pedidoCompraNumero,
             COALESCE(pc.status, pcn.status) AS pedidoCompraStatus
      FROM ssl_certificados s
      LEFT JOIN pessoas p ON p.id = s.clienteId
      LEFT JOIN contratos c ON c.id = s.contratoId
      LEFT JOIN pedidos_compra pc ON pc.id = s.pedidoCompraId
      LEFT JOIN ssl_pedidos_nicsrs sn ON sn.id = s.pedidoNicsrsId
      LEFT JOIN pedidos_compra pcn ON pcn.id = sn.pedidoCompraId
      WHERE 1=1
    `;
    const params = [];
    if (contratoId) { sql += ' AND s.contratoId = ?'; params.push(Number(contratoId)); }
    if (clienteId)  { sql += ' AND s.clienteId = ?';  params.push(Number(clienteId)); }
    if (status)     { sql += ' AND s.status = ?';     params.push(status); }
    // A busca aceita o que a pessoa tem na mão vindo da outra tela: o número
    // do pedido (PC-2026-0004), a ordem da NicSRS (RC…) e o Application ID.
    if (q) {
      sql += ` AND (s.commonName LIKE ? OR s.dominiosSan LIKE ? OR s.certId = ?
                    OR s.orderNum LIKE ? OR pc.numero LIKE ? OR pcn.numero LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`, q, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY s.id DESC';
    if (limit !== null) { sql += ' LIMIT ?'; params.push(Number(limit) || 200); }
    return db.prepare(sql).all(...params);
  }

  app.get('/api/ssl/certificados', (req, res) => {
    try {
      const { contratoId, clienteId, status, q, limit } = req.query;
      const certificados = consultarCertificados({ contratoId, clienteId, status, q, limit });

      const kpis = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status='emitido' THEN 1 ELSE 0 END) AS emitidos,
          SUM(CASE WHEN status='aguardando-aprovacao' THEN 1 ELSE 0 END) AS aguardandoAprovacao,
          SUM(CASE WHEN status='aguardando-dados' THEN 1 ELSE 0 END) AS aguardandoDados,
          -- 'em-validacao' entra aqui pelo mesmo motivo do scheduler: é o status
          -- da compra feita pelo sistema. Fora desta conta, o certificado não
          -- aparecia em KPI nenhum — nem emitido, nem em andamento.
          SUM(CASE WHEN status IN ('comprado','reemitindo','em-validacao') THEN 1 ELSE 0 END) AS emAndamento,
          SUM(CASE WHEN status='emitido' AND endDate IS NOT NULL AND date(endDate) <= date('now','+30 days') THEN 1 ELSE 0 END) AS arquivoVencendo30d,
          SUM(CASE WHEN cobertoAte IS NOT NULL AND date(cobertoAte) <= date('now','+90 days') AND status NOT IN ('cancelado','expirado') THEN 1 ELSE 0 END) AS assinaturaVencendo90d
        FROM ssl_certificados
      `).get();

      res.json({ success: true, certificados, kpis, status: STATUS, dcvMetodos: DCV_METODOS });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Relatório da carteira, nos mesmos filtros do grid.
   *
   * O caminho é `/api/ssl/relatorio/...` e não `/api/ssl/certificados/...` de
   * propósito: sob o segundo, `/certificados/:id` casaria primeiro e o pedido
   * viraria uma busca pelo certificado de id "relatorio.xlsx" — 404 mudo, o
   * pior tipo de defeito para depurar. O prefixo de RBAC continua sendo
   * `/api/ssl` (perfis-acesso.js corta no 2º segmento), então nada muda no
   * perfis-api-map.js.
   *
   * Sem LIMIT: o teto de 200 do grid é da tela, e um relatório que corta
   * silenciosamente no 201 presta contas errado.
   */
  function dadosRelatorio(req) {
    const { contratoId, clienteId, status, q } = req.query;
    const linhas = consultarCertificados({ contratoId, clienteId, status, q, limit: null });
    return { linhas, filtros: { contratoId, clienteId, status, q } };
  }

  app.get('/api/ssl/relatorio/certificados.xlsx', (req, res) => {
    try {
      const { linhas, filtros } = dadosRelatorio(req);
      const buf = sslRelatorio.gerarXlsx(linhas, filtros);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',
        `attachment; filename="certificados-ssl-${new Date().toISOString().slice(0, 10)}.xlsx"`);
      res.send(buf);
    } catch (err) {
      console.error('[ssl-relatorio xlsx]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/ssl/relatorio/certificados.pdf', (req, res) => {
    try {
      const { linhas, filtros } = dadosRelatorio(req);
      const emitente = db.prepare('SELECT razaoSocial, cnpj FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {};
      res.setHeader('Content-Type', 'application/pdf');
      // `inline` porque o botão abre em aba nova: o fluxo normal é conferir na
      // tela e mandar imprimir, não salvar no disco.
      res.setHeader('Content-Disposition',
        `inline; filename="certificados-ssl-${new Date().toISOString().slice(0, 10)}.pdf"`);
      sslRelatorio.gerarPdf(res, linhas, filtros, emitente);
    } catch (err) {
      console.error('[ssl-relatorio pdf]', err);
      // Cabeçalho já enviado = o PDF começou a sair; mandar JSON agora
      // produziria um arquivo corrompido em vez de um erro.
      if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
      else res.end();
    }
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

  // O pedido de compra não nasce do certificado. A direção é
  // contrato → pedido → certificado, e a rota que fazia o inverso saiu:
  // criava pedido sem contrato, que depois não achava o certificado.
  // Para gerar o pedido, use /api/contratos/:id/itens/:itemId/pedido-compra.

  // ---- COMPRA: único ponto que gasta saldo. Sempre manual, sempre explícito.
  app.post('/api/ssl/certificados/:id/aprovar', async (req, res) => {
    try {
      const cert = db.prepare('SELECT * FROM ssl_certificados WHERE id = ?').get(Number(req.params.id));
      if (!cert) return res.status(404).json({ success: false, error: 'Certificado não encontrado' });
      // `rascunho` entra porque o CSR deixou de ser obrigatório: certificado
      // salvo sem CSR nasce rascunho e mesmo assim pode ser comprado.
      if (!['aguardando-aprovacao', 'rascunho'].includes(cert.status)) {
        return res.status(409).json({ success: false, error: `Só é possível comprar em rascunho ou aguardando-aprovacao (atual: ${cert.status})` });
      }
      if (!cert.commonName) return res.status(400).json({ success: false, error: 'Domínio principal não informado' });
      // Curinga incompatível com o produto: a NicSRS recusaria, e o erro dela
      // não diz o que fazer. Aqui a mensagem já traz o domínio correto.
      const prodCat = db.prepare(
        'SELECT code, productName, validationType, supportWildcard, supportStandard FROM ssl_produtos_nicsrs WHERE code = ?'
      ).get(cert.productCode);
      const erroCuringa = erroDominioProduto(prodCat, cert.commonName);
      if (erroCuringa) return res.status(400).json({ success: false, error: erroCuringa.mensagem });

      const administrator = administradorPadrao(db, req.body.administrator);
      const refId = cert.refId || gerarRefId(db, cert.id);
      // Grava o refId ANTES da chamada: se a resposta se perder, o retry usa o
      // mesmo refId e a NicSRS não cobra duas vezes.
      db.prepare('UPDATE ssl_certificados SET refId = ? WHERE id = ?').run(refId, cert.id);

      const params = montarParams(db, cert, administrator, req.body.organizationInfo);

      // Última parada antes de gastar a chamada: contato incompleto num OV/EV
      // volta da NicSRS como `-1` ilegível, e o pedido fica em
      // aguardando-aprovacao sem que a tela diga o que corrigir.
      const erroContatos = erroDadosOv(params, prodCat && prodCat.validationType);
      if (erroContatos) {
        db.prepare('UPDATE ssl_certificados SET ultimoErro = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
          .run(erroContatos, cert.id);
        return res.status(400).json({ success: false, error: erroContatos });
      }

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

      const dadosPlace = resposta.data || {};
      const certId = dadosPlace.certId ? String(dadosPlace.certId) : null;
      // O place já devolve o DCV a publicar — guardar aqui evita esperar o
      // ciclo do scheduler para a tela mostrar o que configurar no DNS.
      if (dadosPlace.DCVdnsHost && dadosPlace.DCVdnsValue) {
        db.prepare('UPDATE ssl_certificados SET dcvDetalhe = ? WHERE id = ?').run(
          JSON.stringify({ tipo: dadosPlace.DCVdnsType, host: dadosPlace.DCVdnsHost, valor: dadosPlace.DCVdnsValue }),
          cert.id);
      }
      // Comprado sem CSR: o par é da NicSRS e só vem pelo collect. Best-effort,
      // porque falhar aqui não pode desfazer uma compra que deu certo.
      if (!cert.csr && certId) {
        try {
          const col = await nicsrs.collect(getToken(db), certId);
          let ap = (col.data || {}).applyParams;
          if (typeof ap === 'string') ap = JSON.parse(ap);
          if (ap && ap.csr) db.prepare('UPDATE ssl_certificados SET csr = ? WHERE id = ?').run(ap.csr, cert.id);
        } catch (err) {
          console.error('[ssl] collect do CSR gerado:', err.message);
        }
      }
      // Custo informado > custo do cadastro > preço de tabela da NicSRS para o
      // período. Sem o último, certificado cadastrado sem custo compraria sem
      // gerar conta a pagar — a despesa some do financeiro.
      let custoUsd = req.body.custoUsd != null ? Number(req.body.custoUsd) : cert.custoUsd;
      if (!custoUsd) {
        try {
          const tab = db.prepare('SELECT basePrice FROM ssl_produtos_nicsrs WHERE code = ?').get(cert.productCode);
          const precos = tab && tab.basePrice ? JSON.parse(tab.basePrice) : null;
          if (precos) {
            const chave = `price${String((Number(cert.anos) || 1) * 12).padStart(3, '0')}`;
            const v = Number(precos[chave]);
            if (Number.isFinite(v) && v > 0) custoUsd = v;
          }
        } catch { /* catálogo sem preço utilizável */ }
      }
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
      let pedidoCompra = null;
      if (aplicado.status !== cert.status) {
        registrarEvento(db, cert.id, 'status', `Status ${cert.status} → ${aplicado.status}`, aplicado, req.user?.username);
        // Mesma regra do scheduler: emitiu, o pedido que o pagou está atendido.
        if (aplicado.status === 'emitido') {
          try {
            pedidoCompra = fecharPedidoCompraSeEmitido(db, { ...cert, status: 'emitido' }, req.user?.username);
          } catch (err) { pedidoCompra = { erro: err.message }; }
        }
      }
      res.json({ success: true, ...aplicado, ...(pedidoCompra ? { pedidoCompra } : {}) });
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

      // Estado final não se cancela: a NicSRS recusaria, e sem esta guarda um
      // POST repetido (dois cliques, retry de rede, chamada direta à API) tenta
      // cancelar de novo o que já acabou. O botão da tela já esconde estes
      // casos — mas a tela não é a única porta, e /aprovar aqui do lado protege
      // do mesmo jeito.
      const FINAIS = ['cancelado', 'expirado', 'substituido'];
      if (FINAIS.includes(cert.status)) {
        return res.status(409).json({ success: false,
          error: `Nada a cancelar: o certificado já está ${cert.status}` });
      }

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

      // Visão de futuro. `reissuePendente` só mostra o que JÁ venceu o prazo —
      // suficiente enquanto o arquivo dura 200 dias e cada certificado é
      // reemitido uma vez por ano. Quando o teto cair para 47 dias serão ~11
      // reemissões anuais por certificado, e saber o que vem pela frente deixa
      // de ser conveniência. `dcvMethod` vai junto porque é ele que diz se a
      // reemissão passa sozinha ou vai parar num clique do cliente.
      const janela = Math.min(365, Math.max(1, Number(req.query.dias) || 60));
      const reissueFuturo = db.prepare(`
        SELECT id, commonName, endDate, cobertoAte, proximoReissueEm, dcvMethod, dcvEmail,
               CAST(julianday(proximoReissueEm) - julianday(?) AS INT) AS emDias
        FROM ssl_certificados
        WHERE status = 'emitido' AND proximoReissueEm IS NOT NULL
          AND date(proximoReissueEm) > date(?)
          AND date(proximoReissueEm) <= date(?, '+' || ? || ' days')
        ORDER BY proximoReissueEm
      `).all(hoje, hoje, hoje, janela);

      // Quem, dentro da janela, depende de alguém clicar num e-mail.
      const reissueComCliqueDoCliente = reissueFuturo.filter(r => r.dcvMethod === 'EMAIL').length;
      const renovacaoPendente = db.prepare(`
        SELECT s.id, s.commonName, s.cobertoAte, c.numero AS contratoNumero, c.status AS contratoStatus
        FROM ssl_certificados s
        LEFT JOIN contratos c ON c.id = s.contratoId
        WHERE s.status IN ('emitido','comprado') AND s.cobertoAte IS NOT NULL
          AND date(s.cobertoAte) <= date('now','+90 days')
        ORDER BY s.cobertoAte
      `).all();
      res.json({ success: true, reissuePendente, reissueFuturo, renovacaoPendente,
                 janelaDias: janela, reissueComCliqueDoCliente });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = {
  registrarRotasSslCertificados,
  migrarDB,
  sincronizarProdutos,
  atualizarPrecosProdutos,
  criarProdutosFaltantes,
  comprarAssinaturasDoPedido,
  organizacaoDoCliente,
  // Puras, exportadas para `scripts/test-ssl-contato-ov.js`: é nelas que mora a
  // regra que recusou a compra do #61.
  mesclarContato,
  erroDadosOv,
  paraContatoNicsrs,
  montarParams,
  comprarCertificadosDoPedido,
  lancarComprasNoFinanceiro,
  inspecionarCSR,
  emailsAprovadores,
  dominiosParaDcv,
  importarDaNicsrs,
  obterCotacaoUsd,
  VENDORS,
  aplicarCollect,
  fecharPedidoCompraSeEmitido,
  certificadosDoPedidoCompra,
  modoCompra,
  comprarPeloConsole,
  registrarComprasNoPainel,
  reconciliarComprasNicsrs,
  urlCompraNoPainel,
  antecedenciaReissue,
  registrarEvento,
  getConfig,
  addDias,
  hojeIso,
  STATUS,
  DCV_METODOS,
};
