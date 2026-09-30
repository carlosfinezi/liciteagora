/**
 * Os quatro campos novos do emissor de NFC-e, e a reconciliação por chave.
 *
 * Roda o `emitirNFCe` de verdade contra uma CÓPIA descartável de um tenant,
 * com a SEFAZ substituída por um duble. Nada é transmitido, nenhum documento
 * é emitido e nada é escrito em `data/`.
 *
 * O duble troca três métodos no protótipo do `Tools` da node-sped-nfe:
 * `xmlSign`, `sefazEnviaLote` e `consultarNFe`. O `Make`, que monta o XML,
 * continua sendo o real — é ele que estamos medindo. O certificado é um pfx
 * de mentira com senha em base64 (formato legado, que `cert-senha` lê sem a
 * chave do sistema); ele nunca é aberto, porque quem o abriria era justamente
 * o método substituído.
 *
 * O que está sob prova, além dos campos novos: **o balcão não mudou**. Metade
 * dos casos existe só para isso — payload sem os campos tem de produzir o XML
 * de sempre, byte a byte no que importa.
 *
 * Roda da raiz do projeto:  node scripts/test-nfce-motor-catalogo.js
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { copiaDoTenant } = require('./banco-de-teste');

const RAIZ = path.join(__dirname, '..');

let falhas = 0;
let total = 0;
function ok(nome, condicao, detalhe) {
  total++;
  if (condicao) console.log(`  ok   ${nome}`);
  else { falhas++; console.log(`  FALHA ${nome}${detalhe ? ' — ' + detalhe : ''}`); }
}

// ── o duble da SEFAZ ────────────────────────────────────────────────────────
// Guarda o que recebeu, para os asserts olharem o XML que teria sido enviado.
const espiao = { xmlAssinado: null, chaveConsultada: null, consultas: 0, envios: 0 };
let modoEnvio = 'autorizado';   // 'autorizado' | 'rejeitado' | 'timeout'
let modoConsulta = 'autorizada'; // 'autorizada' | 'nao-consta' | 'erro'

const CHAVE = (xml) => (xml.match(/Id="NFe(\d{44})"/) || [])[1] || '0'.repeat(44);

function respostaAutorizada(xml) {
  return '<retEnviNFe><cStat>104</cStat><xMotivo>Lote processado</xMotivo>'
    + `<protNFe versao="4.00"><infProt><chNFe>${CHAVE(xml)}</chNFe>`
    + '<cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>'
    + '<nProt>915260000123456</nProt></infProt></protNFe></retEnviNFe>';
}
function respostaRejeitada(xml) {
  return '<retEnviNFe><cStat>104</cStat><xMotivo>Lote processado</xMotivo>'
    + `<protNFe versao="4.00"><infProt><chNFe>${CHAVE(xml)}</chNFe>`
    + '<cStat>539</cStat><xMotivo>Duplicidade de NF-e com diferenca na chave de acesso</xMotivo>'
    + '</infProt></protNFe></retEnviNFe>';
}
/* A consulta por chave. O envelope responde 100 nos DOIS casos — é o cStat de
   dentro do protNFe que distingue "autorizada" de "não consta". É exatamente
   a confusão que a correção do catch precisa não cometer. */
function consultaAutorizada(chave) {
  return '<retConsSitNFe><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>'
    + `<chNFe>${chave}</chNFe><protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe>`
    + '<cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>'
    + '<nProt>915260000999888</nProt></infProt></protNFe></retConsSitNFe>';
}
function consultaNaoConsta(chave) {
  return '<retConsSitNFe><cStat>100</cStat><xMotivo>Consulta a NF-e atendida</xMotivo>'
    + `<chNFe>${chave}</chNFe><protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe>`
    + '<cStat>217</cStat><xMotivo>NF-e nao consta na base de dados da SEFAZ</xMotivo>'
    + '</infProt></protNFe></retConsSitNFe>';
}
/* 101 é "cancelamento homologado". Aparece quando a nota foi cancelada por
   outro caminho — outro sistema, o portal da SEFAZ — e o ERP ainda não sabe. */
function consultaCancelada(chave) {
  return '<retConsSitNFe><cStat>100</cStat><xMotivo>Consulta a NF-e atendida</xMotivo>'
    + `<chNFe>${chave}</chNFe><protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe>`
    + '<cStat>101</cStat><xMotivo>Cancelamento de NF-e homologado</xMotivo>'
    + '<nProt>915260000777666</nProt></infProt></protNFe></retConsSitNFe>';
}

async function instalarDuble() {
  const lib = await import('node-sped-nfe');
  lib.Tools.prototype.xmlSign = async function (xml) {
    espiao.xmlAssinado = xml;
    return xml;                       // sem assinar: o que medimos é o conteúdo
  };
  lib.Tools.prototype.sefazEnviaLote = async function (xml) {
    espiao.envios++;
    if (modoEnvio === 'timeout') {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    }
    return modoEnvio === 'rejeitado' ? respostaRejeitada(xml) : respostaAutorizada(xml);
  };
  lib.Tools.prototype.consultarNFe = async function (chave) {
    espiao.consultas++;
    espiao.chaveConsultada = chave;
    if (modoConsulta === 'erro') throw new Error('SEFAZ fora do ar');
    if (modoConsulta === 'nao-consta') return consultaNaoConsta(chave);
    if (modoConsulta === 'cancelada') return consultaCancelada(chave);
    return consultaAutorizada(chave);
  };
}

// ── o banco ─────────────────────────────────────────────────────────────────
const db = new Database(copiaDoTenant('produtosbomgosto'));

/* Certificado de mentira. O pfx nunca é aberto (xmlSign está substituído), e a
   senha vai em base64 puro, que é o formato legado — `cert-senha.decifrarSenha`
   o lê sem a chave do sistema, que não existe fora do systemd. */
db.prepare(`INSERT INTO certificado_digital (id, certificadoBase64, senhaCriptografada, titular, validade)
  VALUES (1, ?, ?, 'TESTE', '2030-01-01')
  ON CONFLICT(id) DO UPDATE SET certificadoBase64 = excluded.certificadoBase64,
    senhaCriptografada = excluded.senhaCriptografada`)
  .run(Buffer.from('pfx-de-mentira').toString('base64'),
       Buffer.from('senha-de-mentira').toString('utf8').toString('base64'));

db.prepare(`UPDATE nfce_config SET tpAmb = 2, serie = 1, proximoNumero = 9001,
  csc = 'CSC-DE-TESTE-0000000000000000000000000000000', cscId = '000001' WHERE id = 1`).run();

const emitente = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get();

// A natureza: precisa emitir documento fiscal e não gerar financeiro (senão
// exigiria consumidor identificado, que é outro assunto).
const natureza = db.prepare(`SELECT * FROM tipos_operacao
  WHERE ativo = 1 AND emiteNFe = 1 AND geraFinanceiro = 0 AND categoriaOperacao = 'venda'
  ORDER BY id LIMIT 1`).get()
  || db.prepare(`SELECT * FROM tipos_operacao WHERE ativo = 1 AND emiteNFe = 1
       AND categoriaOperacao = 'venda' ORDER BY id LIMIT 1`).get();
if (!natureza) { console.log('FALHA: tenant sem natureza de venda que emita NF-e'); process.exit(1); }
console.log(`  (emitente ${emitente.cidade}/${emitente.uf} · natureza ${natureza.codigo} — ${natureza.descricao})`);

let seq = 0;
function produto() {
  seq++;
  return db.prepare(`INSERT INTO produtos (sku, descricao, unidade, ncm, codigoBarras,
      origem, csosn, cstPIS, cstCOFINS, cfopPadrao, precoVenda, ativo)
    VALUES (?, ?, 'UN', '09109900', '7891234567895', '0', '102', '49', '49', '5102', 25, 1)`)
    .run(`MOTOR-${seq}`, `PRODUTO MOTOR ${seq}`).lastInsertRowid;
}

const itemBase = (id) => ({
  produtoId: id, sku: `MOTOR-${seq}`, descricao: `PRODUTO MOTOR ${seq}`,
  ncm: '09109900', unidade: 'UN', quantidade: 2, precoUnitario: 25, valorTotal: 50,
});

function payloadBalcao(extra = {}) {
  const p = produto();
  return Object.assign({
    tipoOperacaoId: natureza.id,
    itens: [itemBase(p)],
    pagamentos: [{ tPag: '01', valor: 50 }],
    /* Consumidor identificado em todos os casos. A natureza de venda do
       tenant gera financeiro, e o emissor (corretamente) exige CPF nesse
       caso; sem ele, todo teste morreria nessa guarda antes de chegar ao
       que está sob prova. Como efeito bem-vindo, o XML ganha <dest>, e é
       contra ele que a posição do grupo <entrega> é medida. */
    consumidorCpfCnpj: '52998224725',
    consumidorNome: 'CLIENTE DE TESTE',
    efeitosJaAplicados: true,   // o teste mede o XML, não os efeitos colaterais
  }, extra);
}

const reset = () => { espiao.xmlAssinado = null; espiao.chaveConsultada = null;
                      espiao.consultas = 0; espiao.envios = 0; };
const trecho = (xml, tag) => (xml.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`)) || [''])[0];

(async () => {
  await instalarDuble();
  const { emitirNFCe } = require(path.join(RAIZ, 'nfce-routes'));

  /* As rotas registradas num app de mentira que guarda os handlers. Como são
     async, o `chamar` ESPERA — o harness síncrono das outras suítes engoliria
     a resposta e o teste passaria sem ter medido nada. */
  const rotas = new Map();
  {
    const reg = (m) => (url, ...fns) => rotas.set(m + ' ' + url, fns[fns.length - 1]);
    const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), use() {} };
    require(path.join(RAIZ, 'nfce-routes')).registrarRotasNFCe(app, db);
  }
  async function chamar(m, url, params, body) {
    const fn = rotas.get(m + ' ' + url);
    if (!fn) throw new Error('rota não registrada: ' + m + ' ' + url);
    let corpo = null, status = 200, enviado = null;
    const headers = {};
    const res = {
      json: (d) => { corpo = d; return res; },
      status: (s) => { status = s; return res; },
      setHeader: (k, v) => { headers[k] = v; return res; },
      send: (b) => { enviado = b; return res; },
      end: () => res,
    };
    await fn({ params: params || {}, query: {}, body: body || {},
               session: { userId: 1, perfil: 'admin' } }, res);
    return { status, body: corpo, enviado, headers };
  }

  // ── A. o balcão não mudou ─────────────────────────────────────────────────
  // Esta é a metade que protege o legado: payload sem campo novo tem de sair
  // exatamente como saía antes da Fase 2A.
  {
    reset(); modoEnvio = 'autorizado';
    const r = await emitirNFCe(db, payloadBalcao());
    const x = espiao.xmlAssinado;
    ok('A1 a nota foi autorizada', r.cStat === '100', `cStat=${r.cStat} ${r.xMotivo}`);
    ok('A2 indPres continua 1 (presencial)', /<indPres>1<\/indPres>/.test(x));
    ok('A3 modFrete continua 9 (sem transporte)', /<modFrete>9<\/modFrete>/.test(x));
    /* A lib completa o ICMSTot e sempre emite <vFrete>. O que prova que o
       balcão não mudou é o VALOR ser zero, não a tag faltar. */
    ok('A4 vFrete continua zerado', /<vFrete>0.00<\/vFrete>/.test(x), trecho(x, 'ICMSTot'));
    ok('A5 NÃO existe grupo de entrega', !/<entrega>/.test(x));
    ok('A6 o total é a soma dos itens', /<vNF>50.00<\/vNF>/.test(x), trecho(x, 'ICMSTot'));
    ok('A7 nenhuma consulta por chave foi feita', espiao.consultas === 0);
    ok('A8 o modelo é 65', /<mod>65<\/mod>/.test(x));
  }

  // ── B. indPres ────────────────────────────────────────────────────────────
  {
    reset();
    await emitirNFCe(db, payloadBalcao({ indPres: '2' }));
    ok('B1 indPres 2 (internet) chega ao XML', /<indPres>2<\/indPres>/.test(espiao.xmlAssinado));

    reset();
    await emitirNFCe(db, payloadBalcao({ indPres: 2 }));
    ok('B2 indPres numérico também vale (o XML é texto)',
      /<indPres>2<\/indPres>/.test(espiao.xmlAssinado));
  }

  // ── C. frete ──────────────────────────────────────────────────────────────
  // As duas casas do XML andam juntas: vFrete no ICMSTot e modFrete no transp.
  // Separadas, a SEFAZ devolve 531 (soma dos componentes não fecha).
  {
    reset();
    await emitirNFCe(db, payloadBalcao({
      frete: { valor: 12, modFrete: '0' },
      pagamentos: [{ tPag: '01', valor: 62 }],
    }));
    const x = espiao.xmlAssinado;
    ok('C1 vFrete entra no ICMSTot', /<vFrete>12.00<\/vFrete>/.test(x), trecho(x, 'ICMSTot'));
    ok('C2 modFrete vira 0 (por conta do emitente)', /<modFrete>0<\/modFrete>/.test(x));
    ok('C3 o vNF soma itens + frete', /<vNF>62.00<\/vNF>/.test(x), trecho(x, 'ICMSTot'));
    ok('C4 o pagamento bate com o vNF', /<vPag>62.00<\/vPag>/.test(x));

    // Pagamento sem o frete tem de ser RECUSADO — é a guarda que já existia,
    // e ela precisa continuar valendo agora que o vNF mudou de fórmula.
    reset();
    let recusou = null;
    try {
      await emitirNFCe(db, payloadBalcao({
        frete: { valor: 12, modFrete: '0' },
        pagamentos: [{ tPag: '01', valor: 50 }],   // esqueceu o frete
      }));
    } catch (e) { recusou = e.message; }
    ok('C5 pagamento que ignora o frete é recusado antes da SEFAZ',
      recusou && /não bate com o total/.test(recusou), recusou || '(não recusou)');
    ok('C6 e nada foi enviado nesse caso', espiao.envios === 0);

    // Frete zero não pode inventar vFrete: seria informação que nunca existiu.
    reset();
    await emitirNFCe(db, payloadBalcao({ frete: { valor: 0, modFrete: '0' } }));
    ok('C7 frete zero mantém vFrete em 0.00',
      /<vFrete>0.00<\/vFrete>/.test(espiao.xmlAssinado),
      trecho(espiao.xmlAssinado, 'ICMSTot'));
    ok('C8 mas o modFrete do payload é respeitado mesmo com frete zero',
      /<modFrete>0<\/modFrete>/.test(espiao.xmlAssinado));

    reset();
    let negou = null;
    try { await emitirNFCe(db, payloadBalcao({ frete: { valor: -5, modFrete: '0' } })); }
    catch (e) { negou = e.message; }
    ok('C9 frete negativo é recusado', negou && /negativo/.test(negou), negou || '(não recusou)');

    /* O modal vai cru para o XML: um valor não numérico sairia como
       <modFrete>NaN</modFrete> e voltaria da SEFAZ como rejeição de schema,
       longe daqui e sem dizer o que estava errado. */
    reset();
    let modalRuim = null;
    try { await emitirNFCe(db, payloadBalcao({ frete: { valor: 5, modFrete: 'entregador' } })); }
    catch (e) { modalRuim = e.message; }
    ok('C10 modalidade de frete não numérica é recusada',
      modalRuim && /Modalidade de frete inválida/.test(modalRuim), modalRuim || '(não recusou)');
    ok('C11 e nada foi enviado nesse caso', espiao.envios === 0);
  }

  // ── D. grupo <entrega> ────────────────────────────────────────────────────
  {
    reset();
    await emitirNFCe(db, payloadBalcao({
      entrega: {
        xLgr: 'RUA DAS FLORES', nro: '250', xCpl: null, xBairro: 'NOVO HORIZONTE',
        cMun: String(emitente.codigoMunicipio), xMun: emitente.cidade,
        UF: emitente.uf, CEP: '68500000',
      },
    }));
    const x = espiao.xmlAssinado;
    ok('D1 o grupo de entrega saiu no XML', /<entrega>/.test(x));
    ok('D2 com o logradouro certo', /<entrega>[\s\S]*RUA DAS FLORES/.test(x));
    ok('D3 posicionado antes do primeiro <det>', x.indexOf('<entrega>') < x.indexOf('<det '),
      `entrega@${x.indexOf('<entrega>')} det@${x.indexOf('<det ')}`);
    ok('D4 depois do destinatário (é a ordem que o schema exige)',
      x.indexOf('<dest>') > 0 && x.indexOf('<dest>') < x.indexOf('<entrega>'));
    ok('D5 campo nulo não virou tag vazia', !/<xCpl>/.test(trecho(x, 'entrega')));
  }

  // ── E. reconciliação por chave: o achado central ──────────────────────────
  // O envio estoura por timeout, mas a SEFAZ autorizou. Antes, isto perdia a
  // nota e travava a numeração; agora a consulta responde e a gravação segue.
  {
    reset(); modoEnvio = 'timeout'; modoConsulta = 'autorizada';
    const antes = db.prepare('SELECT proximoNumero FROM nfce_config WHERE id = 1').get().proximoNumero;
    const r = await emitirNFCe(db, payloadBalcao());
    const depois = db.prepare('SELECT proximoNumero FROM nfce_config WHERE id = 1').get().proximoNumero;

    ok('E1 a emissão NÃO estourou — a consulta salvou', r && r.cStat === '100',
      r ? `cStat=${r.cStat}` : '(lançou)');
    ok('E2 a consulta foi feita uma vez', espiao.consultas === 1, `consultas=${espiao.consultas}`);
    ok('E3 consultou a chave do XML que tinha sido enviado',
      espiao.chaveConsultada === CHAVE(espiao.xmlAssinado),
      `consultou ${espiao.chaveConsultada}`);
    ok('E4 NÃO houve reenvio (reenviar criaria a segunda nota)', espiao.envios === 1,
      `envios=${espiao.envios}`);
    ok('E5 a nota foi gravada como autorizada', (() => {
      const n = db.prepare('SELECT statusSefaz, protocoloAutorizacao FROM nfce WHERE id = ?').get(r.id);
      return n && n.statusSefaz === 'autorizada' && n.protocoloAutorizacao === '915260000999888';
    })());
    ok('E6 o protocolo veio da CONSULTA, não do envio', r.protocolo === '915260000999888',
      `protocolo=${r.protocolo}`);
    ok('E7 a numeração avançou (é o que destrava a próxima venda)', depois === antes + 1,
      `${antes} → ${depois}`);
    ok('E8 o XML gravado é um nfeProc envelopado', (() => {
      const n = db.prepare('SELECT xmlAssinado FROM nfce WHERE id = ?').get(r.id);
      return n && n.xmlAssinado.includes('<nfeProc') && n.xmlAssinado.includes('<protNFe');
    })());
  }

  // ── F. a consulta NÃO pode inventar autorização ───────────────────────────
  // cStat 100 no envelope com 217 no protocolo é "não consta". Tratar isso
  // como autorizada gravaria uma nota que a SEFAZ nunca recebeu.
  {
    reset(); modoEnvio = 'timeout'; modoConsulta = 'nao-consta';
    const antes = db.prepare('SELECT proximoNumero FROM nfce_config WHERE id = 1').get().proximoNumero;
    const nAntes = db.prepare('SELECT COUNT(*) c FROM nfce').get().c;
    let erro = null;
    try { await emitirNFCe(db, payloadBalcao()); } catch (e) { erro = e; }
    const depois = db.prepare('SELECT proximoNumero FROM nfce_config WHERE id = 1').get().proximoNumero;

    ok('F1 o erro original sobe quando a nota não consta', erro !== null);
    ok('F2 e é o erro do ENVIO, não um da consulta',
      erro && /timeout/i.test(erro.message), erro && erro.message);
    ok('F3 nada foi gravado', db.prepare('SELECT COUNT(*) c FROM nfce').get().c === nAntes);
    ok('F4 a numeração NÃO avançou', depois === antes, `${antes} → ${depois}`);
    ok('F5 a consulta chegou a ser tentada', espiao.consultas === 1);

    // Consulta que também falha: o comportamento tem de ser o de antes.
    reset(); modoConsulta = 'erro';
    let erro2 = null;
    try { await emitirNFCe(db, payloadBalcao()); } catch (e) { erro2 = e; }
    ok('F6 consulta que estoura não engole o erro do envio',
      erro2 && /timeout/i.test(erro2.message), erro2 && erro2.message);
    modoConsulta = 'autorizada';
  }

  // ── G. rejeição continua sendo rejeição ───────────────────────────────────
  // A SEFAZ RESPONDEU, recusando. Não há o que reconciliar, e a consulta não
  // pode ser acionada: o caminho da rejeição não passa pelo catch.
  {
    reset(); modoEnvio = 'rejeitado';
    const antes = db.prepare('SELECT proximoNumero FROM nfce_config WHERE id = 1').get().proximoNumero;
    const r = await emitirNFCe(db, payloadBalcao());
    const depois = db.prepare('SELECT proximoNumero FROM nfce_config WHERE id = 1').get().proximoNumero;
    ok('G1 a rejeição é devolvida com o cStat', r.cStat === '539', `cStat=${r.cStat}`);
    ok('G2 nenhuma consulta foi feita (a SEFAZ respondeu)', espiao.consultas === 0);
    ok('G3 gravada como rejeitada', (() => {
      const n = db.prepare('SELECT statusSefaz FROM nfce WHERE id = ?').get(r.id);
      return n && n.statusSefaz === 'rejeitada';
    })());
    ok('G4 a numeração NÃO avançou na rejeição', depois === antes, `${antes} → ${depois}`);
    modoEnvio = 'autorizado';
  }

  // ── H. os três campos novos juntos, que é o caso do catálogo ──────────────
  {
    reset();
    const r = await emitirNFCe(db, payloadBalcao({
      indPres: '2',
      frete: { valor: 8.5, modFrete: '0' },
      entrega: {
        xLgr: 'TRAVESSA SAO JOAO', nro: '77', xCpl: 'FUNDOS', xBairro: 'CIDADE NOVA',
        cMun: String(emitente.codigoMunicipio), xMun: emitente.cidade,
        UF: emitente.uf, CEP: '68503000',
      },
      pagamentos: [{ tPag: '17', valor: 58.5 }],
    }));
    const x = espiao.xmlAssinado;
    ok('H1 autorizada', r.cStat === '100');
    ok('H2 internet, frete e entrega no mesmo documento',
      /<indPres>2<\/indPres>/.test(x) && /<vFrete>8.50<\/vFrete>/.test(x) && /<entrega>/.test(x));
    ok('H3 o total fecha com o frete', /<vNF>58.50<\/vNF>/.test(x), trecho(x, 'ICMSTot'));
    ok('H4 o complemento do endereço saiu', /<xCpl>FUNDOS<\/xCpl>/.test(x));
    ok('H5 o PIX foi gravado como meio', /<tPag>17<\/tPag>/.test(x));
    ok('H6 a ordem do XML é <entrega> … <det> … <total> … <pag>', (() => {
      const i = (t) => x.indexOf(t);
      return i('<entrega>') < i('<det ') && i('<det ') < i('<total>') && i('<total>') < i('<pag>');
    })());
  }

  // ── I. o montador alimentando o motor ────────────────────────────────────
  // As outras suítes testam as duas peças separadas. Esta junta: um pedido de
  // catálogo de verdade, traduzido por `nfce-payload`, entregue ao emissor.
  // É onde um desencontro de contrato entre os dois apareceria — por exemplo,
  // o montador somando o frete no pagamento e o motor não o somando no vNF.
  {
    const { payloadDeNFCeDePedido } = require(path.join(RAIZ, 'nfce-payload'));
    const prodId = produto();
    const pessoaId = db.prepare(`INSERT INTO pessoas
        (cpfCnpj, tipo, razaoSocial, telefone, celular, ativo, semDocumento, origem)
      VALUES ('52998224725', 'PF', 'CLIENTE DO CATALOGO', '94999990000', '94999990000', 1, 0, 'catalogo')`)
      .run().lastInsertRowid;

    const numero = `TST-INT-${Date.now()}`;
    const pedidoId = db.prepare(`INSERT INTO pedidos
        (numero, tipo, modoDocumento, clienteId, status, dataPedido, meioPagamento,
         tipoAtendimento, valorFrete, descontoAplicado, valorTotal, tipoOperacaoId,
         enderecoEntrega, numeroEntrega, bairroEntrega, cidadeEntrega, ufEntrega, cepEntrega)
      VALUES (?, 'catalogo', 'pedido', ?, 'entregue', '2026-09-28', '17',
              'entrega', 10, 0, 60, ?, 'RUA DAS FLORES', '250', 'CENTRO', ?, ?, '68500-000')`)
      .run(numero, pessoaId, natureza.id, emitente.cidade, emitente.uf).lastInsertRowid;
    db.prepare(`INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
      VALUES (?, ?, ?, 2, 25, 50)`).run(pedidoId, prodId, `PRODUTO MOTOR ${seq}`);

    const { payload } = payloadDeNFCeDePedido(db, pedidoId, { emitente });
    reset(); modoEnvio = 'autorizado';
    const r = await emitirNFCe(db, payload);
    const x = espiao.xmlAssinado;

    ok('I1 o pedido virou nota autorizada sem ajuste manual', r.cStat === '100',
      `cStat=${r.cStat} ${r.xMotivo}`);
    ok('I2 o vNF é itens + frete, como o pedido dizia', /<vNF>60.00<\/vNF>/.test(x),
      trecho(x, 'ICMSTot'));
    ok('I3 e o pagamento fecha com ele (o contrato entre as duas peças)',
      /<vPag>60.00<\/vPag>/.test(x));
    ok('I4 saiu marcada como venda pela internet', /<indPres>2<\/indPres>/.test(x));
    ok('I5 com o endereço de entrega do pedido', /<entrega>[\s\S]*RUA DAS FLORES/.test(x));
    ok('I6 e o frete no lugar certo', /<vFrete>10.00<\/vFrete>/.test(x)
      && /<modFrete>0<\/modFrete>/.test(x));
    ok('I7 o pedido de origem ficou gravado na nota', (() => {
      const n = db.prepare('SELECT pedidoId FROM nfce WHERE id = ?').get(r.id);
      return n && n.pedidoId === pedidoId;
    })(), 'pedidoId não gravado');

    /* O pedido já reservou na confirmação e já baixou na entrega. Se o
       emissor aplicasse os efeitos de novo, sairia estoque em dobro e uma
       segunda conta a receber — foi o defeito medido em 21/09. O montador
       manda `efeitosJaAplicados`, e é isto que se mede. */
    const movs = db.prepare(`SELECT COUNT(*) c FROM movimentacoes_estoque
      WHERE produtoId = ? AND tipo = 'saida'`).get(prodId).c;
    ok('I8 a emissão NÃO baixou estoque de novo', movs === 0, `${movs} saídas`);

    // A segunda nota para o mesmo pedido tem de esbarrar no índice UNIQUE
    // parcial criado na Fase 1 — a garantia contra nota em dobro.
    let duplicou = null;
    try { await emitirNFCe(db, payloadDeNFCeDePedido(db, pedidoId, { emitente }).payload); }
    catch (e) { duplicou = e.message; }
    ok('I9 segunda NFC-e autorizada para o mesmo pedido é barrada',
      duplicou !== null, '(deixou emitir duas)');
  }

  // ── J. a trava fiscal simétrica ───────────────────────────────────────────
  // Uma venda, um documento. As duas verificações são espelhadas e as duas
  // rodam ANTES de falar com a SEFAZ.
  {
    const { emitirNFe } = require(path.join(RAIZ, 'nfe-emit-routes'));

    /** Um pedido com fatura, para exercitar os dois sentidos. */
    function pedidoComFatura() {
      const prodId = produto();
      const pes = db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, telefone, celular, ativo, semDocumento)
        VALUES (?, 'PF', 'CLIENTE TRAVA', '94999990000', '94999990000', 1, 0)`)
        .run(String(30000000000 + (++seq))).lastInsertRowid;
      const num = `TRV-${Date.now()}-${seq}`;
      const pedId = db.prepare(`INSERT INTO pedidos
          (numero, tipo, modoDocumento, clienteId, status, dataPedido, meioPagamento,
           tipoAtendimento, valorFrete, descontoAplicado, valorTotal, tipoOperacaoId)
        VALUES (?, 'catalogo', 'pedido', ?, 'entregue', '2026-09-28', '01', 'retirada', 0, 0, 50, ?)`)
        .run(num, pes, natureza.id).lastInsertRowid;
      db.prepare(`INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
        VALUES (?, ?, 'ITEM TRAVA', 2, 25, 50)`).run(pedId, prodId);
      const fatId = db.prepare(`INSERT INTO faturas
          (numero, pedidoId, clienteId, dataEmissao, dataVencimento, valorBruto, valorFrete,
           valorDesconto, valorTotal, status, tipoOperacaoId)
        VALUES (?, ?, ?, '2026-09-28', '2026-10-28', 50, 0, 0, 50, 'emitida', ?)`)
        .run(`F-${num}`, pedId, pes, natureza.id).lastInsertRowid;
      return { pedId, fatId, prodId, pes, num };
    }

    // J1-J3: NF-e 55 autorizada bloqueia a NFC-e.
    {
      const c = pedidoComFatura();
      db.prepare(`UPDATE faturas SET statusSefaz='autorizada', chaveAcesso=?, numeroNFe=777,
        protocoloAutorizacao='123' WHERE id = ?`).run('5'.repeat(44), c.fatId);
      reset();
      let erro = null;
      try {
        await emitirNFCe(db, payloadBalcao({ pedidoId: c.pedId, itens: [itemBase(c.prodId)] }));
      } catch (e) { erro = e.message; }
      ok('J1 NF-e autorizada bloqueia a NFC-e do mesmo pedido',
        erro && /já tem NF-e/.test(erro), erro || '(não bloqueou)');
      ok('J2 a mensagem nomeia o pedido e a fatura',
        erro && erro.includes(c.num) && erro.includes(`F-${c.num}`), erro);
      ok('J3 e nada foi transmitido', espiao.envios === 0, `envios=${espiao.envios}`);

      // J4: cancelada NÃO bloqueia — a venda voltou a estar sem documento.
      db.prepare(`UPDATE faturas SET statusSefaz='cancelada_sefaz' WHERE id = ?`).run(c.fatId);
      reset();
      const r = await emitirNFCe(db, payloadBalcao({ pedidoId: c.pedId, itens: [itemBase(c.prodId)] }));
      ok('J4 NF-e CANCELADA não bloqueia a NFC-e', r.cStat === '100', `cStat=${r.cStat}`);

      // J5: rejeitada também não bloqueia (nunca foi documento).
      const c2 = pedidoComFatura();
      db.prepare(`UPDATE faturas SET statusSefaz='rejeitada' WHERE id = ?`).run(c2.fatId);
      reset();
      const r2 = await emitirNFCe(db, payloadBalcao({ pedidoId: c2.pedId, itens: [itemBase(c2.prodId)] }));
      ok('J5 NF-e REJEITADA não bloqueia a NFC-e', r2.cStat === '100', `cStat=${r2.cStat}`);
    }

    // J6-J9: NFC-e autorizada bloqueia a NF-e 55. O sentido oposto.
    {
      const c = pedidoComFatura();
      reset();
      const nota = await emitirNFCe(db, payloadBalcao({ pedidoId: c.pedId, itens: [itemBase(c.prodId)] }));
      ok('J6 (preparo) a NFC-e do pedido foi autorizada', nota.cStat === '100');

      let erro = null;
      try { await emitirNFe(db, c.fatId); } catch (e) { erro = e.message; }
      ok('J7 NFC-e autorizada bloqueia a NF-e 55 da fatura do mesmo pedido',
        erro && /já tem NFC-e/.test(erro), erro || '(não bloqueou)');
      ok('J8 a mensagem diz o número e a série da NFC-e',
        erro && erro.includes(`${nota.nNF}/${nota.serie}`), erro);

      // Cancelar a NFC-e libera a 55. A trava não pode ser permanente.
      db.prepare(`UPDATE nfce SET statusSefaz='cancelada' WHERE id = ?`).run(nota.id);
      let erro2 = null;
      try { await emitirNFe(db, c.fatId); } catch (e) { erro2 = e.message; }
      ok('J9 NFC-e CANCELADA deixa de bloquear a NF-e',
        !erro2 || !/já tem NFC-e/.test(erro2),
        `ainda bloqueando: ${erro2}`);
    }

    // J10: fatura sem pedido (avulsa) não pode quebrar na trava.
    {
      const pes = db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, ativo, semDocumento)
        VALUES (?, 'PF', 'AVULSO', 1, 0)`).run(String(40000000000 + (++seq))).lastInsertRowid;
      const fatId = db.prepare(`INSERT INTO faturas
          (numero, pedidoId, clienteId, dataEmissao, dataVencimento, valorBruto, valorFrete,
           valorDesconto, valorTotal, status)
        VALUES (?, NULL, ?, '2026-09-28', '2026-10-28', 10, 0, 0, 10, 'emitida')`)
        .run(`AV-${seq}`, pes).lastInsertRowid;
      let erro = null;
      try { await emitirNFe(db, fatId); } catch (e) { erro = e.message; }
      ok('J10 fatura sem pedido não estoura na trava (falha por outro motivo)',
        erro && !/já tem NFC-e/.test(erro) && !/pedidoId/.test(erro), erro);
    }

    // J11: a proteção UNIQUE do banco continua de pé, por baixo da trava.
    {
      const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index'
        AND name='idx_nfce_pedido_autorizada'`).get();
      ok('J11 o índice UNIQUE parcial da Fase 1 continua existindo',
        !!idx && /UNIQUE/i.test(idx.sql) && /statusSefaz = 'autorizada'/.test(idx.sql),
        idx ? idx.sql : '(índice sumiu)');
    }
  }

  // ── K. o documento não pode ser inventado ─────────────────────────────────
  // O motor lia `payload.consumidorCpfCnpj` com replace(/\D/g,'') cru. A
  // limpeza apaga LETRAS, e identificadores internos que o ERP grava em
  // pessoas.cpfCnpj podiam sobrar com 11 dígitos e virar CPF de alguém.
  {
    /* Uma natureza que emite documento e NÃO gera financeiro, só para este
       bloco. Sem ela, todo caso morreria antes do XML na guarda "natureza que
       gera conta a receber exige CPF/CNPJ" — e essa guarda passar a disparar
       é, ela própria, uma consequência CORRETA desta etapa: um identificador
       interno deixou de contar como consumidor identificado. O que se mede
       aqui é outra coisa, o conteúdo do XML, e por isso a variável é isolada
       em vez de o teste ser afrouxado. */
    const natSemFin = db.prepare(`INSERT INTO tipos_operacao
        (codigo, descricao, categoriaOperacao, usarEmPedido, emiteNFe, movimentaEstoque,
         geraFinanceiro, cfopInterno, ativo)
      VALUES ('TST-DOC', 'Prova de documento', 'venda', 1, 1, 0, 0, '5102', 1)`)
      .run().lastInsertRowid;
    const semFin = (extra) => payloadBalcao(Object.assign({ tipoOperacaoId: natSemFin }, extra));

    const casos = [
      ['UASG-12345678901', 'identificador de UASG (11 dígitos ao limpar)'],
      ['SD-be7cbfcbd2344f8395f66edae58251b9', 'cadastro sem documento do catálogo'],
      ['EX-NICSRS', 'identificador de fornecedor externo'],
      ['TARIFA-asaas', 'identificador de tarifa'],
    ];
    for (const [doc, oque] of casos) {
      reset();
      await emitirNFCe(db, semFin({ consumidorCpfCnpj: doc, consumidorNome: 'NAO IDENTIFICADO' }));
      const x = espiao.xmlAssinado;
      const dest = (x.match(/<dest>[\s\S]*?<\/dest>/) || [''])[0];
      ok(`K1.${doc.split('-')[0]} ${oque} não vira CPF/CNPJ`,
        !/<CPF>/.test(dest) && !/<CNPJ>/.test(dest), dest.slice(0, 120));
    }

    // O legítimo continua funcionando — nos dois formatos.
    reset();
    await emitirNFCe(db, semFin({ consumidorCpfCnpj: '52998224725' }));
    ok('K2a CPF legítimo continua saindo no XML',
      /<CPF>52998224725<\/CPF>/.test(espiao.xmlAssinado));

    reset();
    await emitirNFCe(db, semFin({ consumidorCpfCnpj: '11.222.333/0001-81' }));
    ok('K2b CNPJ com máscara continua saindo, só com dígitos',
      /<CNPJ>11222333000181<\/CNPJ>/.test(espiao.xmlAssinado));

    // E o que é gravado no banco acompanha o que foi para o XML.
    reset();
    const r = await emitirNFCe(db, semFin({
      consumidorCpfCnpj: 'UASG-12345678901', consumidorNome: 'ORGAO' }));
    const gravado = db.prepare('SELECT consumidorCpfCnpj FROM nfce WHERE id = ?').get(r.id);
    ok('K3 o identificador interno também não é gravado como documento na nfce',
      !gravado.consumidorCpfCnpj, `gravou "${gravado.consumidorCpfCnpj}"`);
  }

  // ── L. consulta por chave e DANFCe ────────────────────────────────────────
  // As rotas são registradas num app de mentira que guarda os handlers. Como
  // as duas são async, o `chamar` espera — o harness síncrono das outras
  // suítes engoliria a resposta.
  {
    ok('L1 a rota de consulta foi registrada', rotas.has('GET /api/nfce/:id/consultar'));
    ok('L2 a rota do DANFCe foi registrada', rotas.has('GET /api/nfce/:id/danfce'));

    // Uma nota autorizada de verdade, para consultar e imprimir.
    reset(); modoEnvio = 'autorizado'; modoConsulta = 'autorizada';
    const nota = await emitirNFCe(db, payloadBalcao());

    // ── DANFCe
    const pdf = await chamar('GET', '/api/nfce/:id/danfce', { id: String(nota.id) });
    ok('L3 o DANFCe respondeu 200', pdf.status === 200, `status ${pdf.status}: ${JSON.stringify(pdf.body)}`);
    /* A lib devolve Uint8Array, e não Buffer — `Buffer.isBuffer` daria false
       num PDF perfeitamente válido. O que prova o formato é a assinatura. */
    const bytes = pdf.enviado && Buffer.from(pdf.enviado);
    ok('L4 é um PDF de verdade (assinatura %PDF-)',
      bytes && bytes.slice(0, 5).toString('latin1') === '%PDF-',
      bytes ? bytes.slice(0, 12).toString('latin1') : '(nada enviado)');
    ok('L5 com tamanho plausível', pdf.enviado && pdf.enviado.length > 1000,
      `${pdf.enviado && pdf.enviado.length} bytes`);
    ok('L6 servido como application/pdf', pdf.headers['Content-Type'] === 'application/pdf');

    // Nota não autorizada não imprime cupom.
    reset(); modoEnvio = 'rejeitado';
    const rej = await emitirNFCe(db, payloadBalcao());
    const pdfRej = await chamar('GET', '/api/nfce/:id/danfce', { id: String(rej.id) });
    ok('L7 nota rejeitada NÃO gera DANFCe', pdfRej.status === 400
      && /não autorizada/.test(pdfRej.body.error), JSON.stringify(pdfRej.body));
    modoEnvio = 'autorizado';

    // ── consulta: nota que está autorizada dos dois lados, nada muda
    const c1 = await chamar('GET', '/api/nfce/:id/consultar', { id: String(nota.id) });
    ok('L8 a consulta respondeu com o cStat do protocolo',
      c1.status === 200 && c1.body.cStat === '100', JSON.stringify(c1.body));
    ok('L9 nada foi atualizado (já estava coerente)', c1.body.atualizado === false);

    // ── consulta que RECUPERA: a nota ficou local como rejeitada, mas a
    // SEFAZ diz que está autorizada. É o caso da resposta perdida.
    reset(); modoEnvio = 'timeout'; modoConsulta = 'nao-consta';
    let perdida = null;
    try { await emitirNFCe(db, payloadBalcao()); } catch (_) { /* esperado */ }
    // força um registro pendente com chave, imitando o estado a recuperar
    const chaveFake = '1'.repeat(44);
    const pendId = db.prepare(`INSERT INTO nfce (numero, serie, chaveAcesso, tpAmb,
        valorProdutos, valorDesconto, valorTotal, statusSefaz, xmlAssinado)
      VALUES (9999, 1, ?, 2, 50, 0, 50, 'pendente', '<NFe><infNFe Id="NFe${chaveFake}"></infNFe></NFe>')`)
      .run(chaveFake).lastInsertRowid;
    modoConsulta = 'autorizada';
    const c2 = await chamar('GET', '/api/nfce/:id/consultar', { id: String(pendId) });
    ok('L10 a consulta promove a nota pendente para autorizada',
      c2.body.atualizado === true && c2.body.statusAtual === 'autorizada', JSON.stringify(c2.body));
    ok('L11 e grava o protocolo que a SEFAZ devolveu', (() => {
      const n = db.prepare('SELECT statusSefaz, protocoloAutorizacao FROM nfce WHERE id = ?').get(pendId);
      return n.statusSefaz === 'autorizada' && n.protocoloAutorizacao === '915260000999888';
    })());
    ok('L12 e envelopa o XML como nfeProc', (() => {
      const n = db.prepare('SELECT xmlAssinado FROM nfce WHERE id = ?').get(pendId);
      return n.xmlAssinado.includes('<nfeProc') && n.xmlAssinado.includes('<protNFe');
    })());

    // ── a consulta NUNCA rebaixa uma autorização local
    modoConsulta = 'nao-consta';
    const c3 = await chamar('GET', '/api/nfce/:id/consultar', { id: String(nota.id) });
    ok('L13 cStat 217 NÃO apaga uma nota autorizada localmente',
      db.prepare('SELECT statusSefaz FROM nfce WHERE id = ?').get(nota.id).statusSefaz === 'autorizada',
      JSON.stringify(c3.body));
    modoConsulta = 'autorizada';

    // ── a consulta detecta cancelamento feito por fora
    // `modoEnvio` volta a 'autorizado': o caso da recuperação, acima, deixou
    // o duble em timeout, e sem isto a emissão desta nota cairia lá.
    modoEnvio = 'autorizado';
    modoConsulta = 'cancelada';
    const nota2 = await (async () => { reset(); return emitirNFCe(db, payloadBalcao()); })();
    const c4 = await chamar('GET', '/api/nfce/:id/consultar', { id: String(nota2.id) });
    ok('L14 a consulta constata cancelamento feito em outro sistema',
      c4.body.atualizado === true && c4.body.statusAtual === 'cancelada', JSON.stringify(c4.body));
    ok('L15 e registra por que o estado mudou', (() => {
      const n = db.prepare('SELECT motivoCancelamento FROM nfce WHERE id = ?').get(nota2.id);
      return n.motivoCancelamento && /consulta/i.test(n.motivoCancelamento);
    })());
    modoConsulta = 'autorizada';

    // ── nota sem chave não tem o que consultar
    const semChave = db.prepare(`INSERT INTO nfce (numero, serie, tpAmb, valorProdutos,
      valorDesconto, valorTotal, statusSefaz) VALUES (8888, 1, 2, 10, 0, 10, 'rejeitada')`).run().lastInsertRowid;
    const c5 = await chamar('GET', '/api/nfce/:id/consultar', { id: String(semChave) });
    ok('L16 nota sem chave é recusada com explicação',
      c5.status === 400 && /nunca chegou a ser transmitida/.test(c5.body.error), JSON.stringify(c5.body));
  }

  // ── M. a emissão pelo PEDIDO (Etapa 5) ───────────────────────────────────
  // A rota que o lojista aciona na tela. O que está sob prova aqui não é o
  // motor — esse já tem os blocos A a L — e sim a porta: quem pode entrar,
  // em que estado, e o que acontece quando a configuração falta.
  const ROTA = 'POST /api/pedidos/:id/emitir-nfce';
  {
    ok('M0 a rota de emissão pelo pedido foi registrada', rotas.has(ROTA));

    const cfgLoja = (v) => db.prepare('UPDATE loja_config SET tipoOperacaoNfceId = ? WHERE id = 1').run(v);
    const emitirPeloPedido = (pedidoId) =>
      chamar('POST', '/api/pedidos/:id/emitir-nfce', { id: String(pedidoId) });

    /** Pedido de catálogo pronto para emitir, com cliente, item e entrega. */
    function pedidoCatalogo(campos = {}) {
      const prodId = produto();
      const pes = db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, telefone, celular, ativo, semDocumento)
        VALUES (?, 'PF', 'CLIENTE CATALOGO', '94999990000', '94999990000', 1, 0)`)
        .run(String(50000000000 + (++seq))).lastInsertRowid;
      const num = `CAT-${Date.now()}-${seq}`;
      const c = Object.assign({ status: 'entregue', tipo: 'catalogo', tipoAtendimento: 'retirada',
        valorFrete: 0, meioPagamento: '17' }, campos);
      const pedId = db.prepare(`INSERT INTO pedidos
          (numero, tipo, modoDocumento, clienteId, status, dataPedido, meioPagamento,
           tipoAtendimento, valorFrete, descontoAplicado, valorTotal, tipoOperacaoId)
        VALUES (?, ?, 'pedido', ?, ?, '2026-09-28', ?, ?, ?, 0, ?, ?)`)
        .run(num, c.tipo, pes, c.status, c.meioPagamento, c.tipoAtendimento,
             c.valorFrete, 50 + c.valorFrete, natureza.id).lastInsertRowid;
      db.prepare(`INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
        VALUES (?, ?, 'ITEM CATALOGO', 2, 25, 50)`).run(pedId, prodId);
      return { pedId, prodId, pes, num };
    }

    // A natureza da NFC-e do catálogo, que a rota exige configurada.
    const natNfce = db.prepare(`INSERT INTO tipos_operacao
        (codigo, descricao, categoriaOperacao, usarEmPedido, emiteNFe, movimentaEstoque,
         geraFinanceiro, cfopInterno, ativo)
      VALUES ('CAT-NFCE', 'Venda pelo catálogo (NFC-e)', 'venda', 1, 1, 0, 0, '5102', 1)`)
      .run().lastInsertRowid;

    // ── M1-M2: os dois estados permitidos
    cfgLoja(natNfce);
    for (const st of ['entregue', 'faturado']) {
      const c = pedidoCatalogo({ status: st });
      reset(); modoEnvio = 'autorizado';
      const r = await emitirPeloPedido(c.pedId);
      ok(`M1.${st} pedido ${st} emite`, r.status === 200 && r.body.autorizada === true,
        `status ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
      ok(`M2.${st} a nota ficou vinculada ao pedido`, (() => {
        const n = db.prepare('SELECT pedidoId, statusSefaz FROM nfce WHERE id = ?').get(r.body.id);
        return n && n.pedidoId === c.pedId && n.statusSefaz === 'autorizada';
      })());
    }

    // ── M3: os estados recusados
    for (const st of ['rascunho', 'confirmado', 'em_separacao', 'cancelado']) {
      const c = pedidoCatalogo({ status: st });
      reset();
      const r = await emitirPeloPedido(c.pedId);
      ok(`M3.${st} pedido ${st} é recusado`,
        r.status === 400 && /entregue ou faturado/.test(r.body.error), JSON.stringify(r.body));
      ok(`M3.${st} e nada foi transmitido`, espiao.envios === 0, `envios=${espiao.envios}`);
    }

    // ── M4: pedido que não é do catálogo
    {
      const c = pedidoCatalogo({ tipo: 'manual' });
      reset();
      const r = await emitirPeloPedido(c.pedId);
      ok('M4 pedido que não é do catálogo é recusado',
        r.status === 400 && /Catálogo Online/.test(r.body.error), JSON.stringify(r.body));
      ok('M4b e nada foi transmitido', espiao.envios === 0);
    }

    // ── M5: natureza ausente — só a EMISSÃO para, e a mensagem orienta
    {
      cfgLoja(null);
      const c = pedidoCatalogo();
      reset();
      const r = await emitirPeloPedido(c.pedId);
      ok('M5 sem natureza configurada, a emissão é recusada',
        r.status === 409 && /Regras fiscais/.test(r.body.error), JSON.stringify(r.body));
      ok('M5b a mensagem diz ONDE configurar, sem citar coluna nem tabela', (() => {
        const m = r.body.error;
        return /Catálogo Online/.test(m)
          && !['tipoOperacaoNfceId', 'loja_config', 'tipos_operacao', 'SQL'].some((v) => m.includes(v));
      })(), r.body.error);
      ok('M5c nada foi transmitido', espiao.envios === 0);
      ok('M5d o PEDIDO continua intacto — não foi bloqueado nem alterado', (() => {
        const p = db.prepare('SELECT status FROM pedidos WHERE id = ?').get(c.pedId);
        return p.status === 'entregue';
      })());
    }

    // ── M6: naturezas inválidas, uma por motivo
    {
      const invalidas = [
        ['inexistente', 999999, /não existe mais/],
        ['inativa', null, /está inativa/],
        ['que não emite', null, /não emite documento fiscal/],
        ['que não é de venda', null, /não é de venda/],
      ];
      invalidas[1][1] = db.prepare(`INSERT INTO tipos_operacao (codigo, descricao, categoriaOperacao,
        usarEmPedido, emiteNFe, movimentaEstoque, geraFinanceiro, ativo)
        VALUES ('CAT-OFF', 'Inativa', 'venda', 1, 1, 0, 0, 0)`).run().lastInsertRowid;
      invalidas[2][1] = db.prepare(`INSERT INTO tipos_operacao (codigo, descricao, categoriaOperacao,
        usarEmPedido, emiteNFe, movimentaEstoque, geraFinanceiro, ativo)
        VALUES ('CAT-SEMNF', 'Sem documento', 'venda', 1, 0, 0, 0, 1)`).run().lastInsertRowid;
      invalidas[3][1] = db.prepare(`INSERT INTO tipos_operacao (codigo, descricao, categoriaOperacao,
        usarEmPedido, emiteNFe, movimentaEstoque, geraFinanceiro, ativo)
        VALUES ('CAT-REM', 'Remessa', 'remessa', 1, 1, 0, 0, 1)`).run().lastInsertRowid;

      for (const [oque, id, regex] of invalidas) {
        cfgLoja(id);
        const c = pedidoCatalogo();
        reset();
        const r = await emitirPeloPedido(c.pedId);
        ok(`M6 natureza ${oque}: recusa com o motivo certo`,
          r.status === 409 && regex.test(r.body.error), JSON.stringify(r.body));
        ok(`M6 natureza ${oque}: nada transmitido`, espiao.envios === 0);
      }
      cfgLoja(natNfce);
    }

    // ── M7: a trava fiscal vale também por esta porta
    {
      const c = pedidoCatalogo();
      const fatId = db.prepare(`INSERT INTO faturas (numero, pedidoId, clienteId, dataEmissao,
          dataVencimento, valorBruto, valorFrete, valorDesconto, valorTotal, status, statusSefaz, chaveAcesso, numeroNFe)
        VALUES (?, ?, ?, '2026-09-28', '2026-10-28', 50, 0, 0, 50, 'emitida', 'autorizada', ?, 555)`)
        .run(`F-${c.num}`, c.pedId, c.pes, '9'.repeat(44)).lastInsertRowid;
      reset();
      const r = await emitirPeloPedido(c.pedId);
      ok('M7 NF-e 55 autorizada impede a emissão pelo pedido',
        r.status === 500 && /já tem NF-e/.test(r.body.error), JSON.stringify(r.body).slice(0, 200));
      ok('M7b e nada foi transmitido', espiao.envios === 0);
      db.prepare('UPDATE faturas SET statusSefaz = ? WHERE id = ?').run('cancelada_sefaz', fatId);
    }

    // ── M8: NFC-e já autorizada não é duplicada
    {
      const c = pedidoCatalogo();
      reset();
      const r1 = await emitirPeloPedido(c.pedId);
      ok('M8 (preparo) a primeira emissão foi autorizada', r1.body.autorizada === true);
      reset();
      const r2 = await emitirPeloPedido(c.pedId);
      ok('M8b a segunda emissão para o mesmo pedido falha',
        !(r2.body && r2.body.autorizada), JSON.stringify(r2.body).slice(0, 200));
      ok('M8c e o pedido continua com UMA nota autorizada',
        db.prepare(`SELECT COUNT(*) c FROM nfce WHERE pedidoId = ? AND statusSefaz = 'autorizada'`)
          .get(c.pedId).c === 1);
    }

    // ── M9: duplo clique — duas chamadas disparadas JUNTAS
    // A garantia não é de tela: é o índice UNIQUE parcial do banco.
    {
      const c = pedidoCatalogo();
      reset();
      const [a, b] = await Promise.all([emitirPeloPedido(c.pedId), emitirPeloPedido(c.pedId)]);
      const autorizadas = db.prepare(
        `SELECT COUNT(*) c FROM nfce WHERE pedidoId = ? AND statusSefaz = 'autorizada'`).get(c.pedId).c;
      ok('M9 duplo clique produz UMA nota autorizada, não duas', autorizadas === 1,
        `${autorizadas} notas · ${JSON.stringify([a.status, b.status])}`);
      ok('M9b uma das duas respostas acusou o problema',
        [a, b].some((x) => !(x.body && x.body.autorizada)),
        JSON.stringify([a.body && a.body.autorizada, b.body && b.body.autorizada]));
    }

    // ── M10: situação incerta não permite emissão cega
    {
      const c = pedidoCatalogo();
      db.prepare(`INSERT INTO nfce (numero, serie, chaveAcesso, tpAmb, valorProdutos,
        valorDesconto, valorTotal, statusSefaz, pedidoId)
        VALUES (7777, 1, ?, 2, 50, 0, 50, 'pendente', ?)`).run('7'.repeat(44), c.pedId);
      reset();
      const r = await emitirPeloPedido(c.pedId);
      ok('M10 NFC-e pendente impede nova emissão',
        r.status === 409 && /situação não confirmada/.test(r.body.error), JSON.stringify(r.body));
      ok('M10b e manda CONSULTAR, não emitir', r.body.acao === 'consultar' && !!r.body.nfceId);
      ok('M10c nada foi transmitido', espiao.envios === 0);
    }

    // ── M11: rejeição chega ao lojista com o motivo, e não some
    {
      const c = pedidoCatalogo();
      reset(); modoEnvio = 'rejeitado';
      const r = await emitirPeloPedido(c.pedId);
      ok('M11 rejeição responde 200 com autorizada:false (não é erro de servidor)',
        r.status === 200 && r.body.success === true && r.body.autorizada === false,
        JSON.stringify(r.body).slice(0, 200));
      ok('M11b o motivo da SEFAZ chega inteiro ao lojista',
        /Duplicidade/.test(r.body.xMotivo || '') && r.body.cStat === '539',
        JSON.stringify({ cStat: r.body.cStat, xMotivo: r.body.xMotivo }));
      ok('M11c e ficou gravado para a tela mostrar depois', (() => {
        const n = db.prepare('SELECT statusSefaz, rejeicaoMotivo FROM nfce WHERE id = ?').get(r.body.id);
        return n.statusSefaz === 'rejeitada' && /539/.test(n.rejeicaoMotivo);
      })());
      ok('M11d rejeitada NÃO impede nova tentativa',
        db.prepare(`SELECT COUNT(*) c FROM nfce WHERE pedidoId = ? AND statusSefaz = 'autorizada'`)
          .get(c.pedId).c === 0);
      modoEnvio = 'autorizado';
    }

    // ── M12: NENHUM segundo efeito. É a razão de existir do efeitosJaAplicados.
    {
      const c = pedidoCatalogo();
      const saidasAntes = db.prepare(
        `SELECT COUNT(*) c FROM movimentacoes_estoque WHERE produtoId = ?`).get(c.prodId).c;
      const crAntes = db.prepare('SELECT COUNT(*) c FROM contas_a_receber').get().c;
      const reservasAntes = db.prepare('SELECT COUNT(*) c FROM reservas_estoque').get().c;

      reset();
      const r = await emitirPeloPedido(c.pedId);
      ok('M12 (preparo) a nota saiu autorizada', r.body.autorizada === true);

      ok('M12a nenhuma movimentação de estoque nova',
        db.prepare(`SELECT COUNT(*) c FROM movimentacoes_estoque WHERE produtoId = ?`).get(c.prodId).c
          === saidasAntes, 'a emissão mexeu no estoque');
      ok('M12b nenhuma conta a receber nova',
        db.prepare('SELECT COUNT(*) c FROM contas_a_receber').get().c === crAntes,
        'a emissão abriu cobrança');
      ok('M12c nenhuma reserva nova',
        db.prepare('SELECT COUNT(*) c FROM reservas_estoque').get().c === reservasAntes);
      ok('M12d nenhuma conta a receber ligada a esta NFC-e',
        db.prepare('SELECT COUNT(*) c FROM contas_a_receber WHERE nfceId = ?').get(r.body.id).c === 0);

      // E a rota realmente manda o sinalizador — não é o motor que adivinha.
      const src = fs.readFileSync(path.join(RAIZ, 'nfce-routes.js'), 'utf8');
      const corpo = src.slice(src.indexOf("app.post('/api/pedidos/:id/emitir-nfce'"));
      const ate = corpo.slice(0, corpo.indexOf('await emitirNFCe('));
      ok('M12e a rota afirma efeitosJaAplicados antes de emitir',
        /payload\.efeitosJaAplicados\s*=\s*true/.test(ate),
        'o sinalizador não é definido na rota');
    }

    // ── M13: depois de autorizada, os três serviços respondem
    {
      const c = pedidoCatalogo();
      reset();
      const r = await emitirPeloPedido(c.pedId);
      const id = String(r.body.id);
      const pdf = await chamar('GET', '/api/nfce/:id/danfce', { id });
      ok('M13a DANFCe disponível após autorização', pdf.status === 200
        && Buffer.from(pdf.enviado).slice(0, 5).toString('latin1') === '%PDF-');
      const xml = await chamar('GET', '/api/nfce/:id/xml', { id });
      ok('M13b XML disponível', xml.status === 200 && /<nfeProc/.test(String(xml.enviado)));
      const cons = await chamar('GET', '/api/nfce/:id/consultar', { id });
      ok('M13c consulta disponível', cons.status === 200 && cons.body.cStat === '100');
    }

    // ── M14: entrega que não vira documento seguro para ANTES de transmitir
    {
      const c = pedidoCatalogo({ tipoAtendimento: 'entrega', valorFrete: 10 });
      db.prepare(`UPDATE pedidos SET enderecoEntrega='RUA X', numeroEntrega='1',
        bairroEntrega='CENTRO', cidadeEntrega='CIDADE QUE NAO EXISTE', ufEntrega=?,
        codigoMunicipioEntrega=NULL WHERE id = ?`).run(emitente.uf, c.pedId);
      reset();
      const r = await emitirPeloPedido(c.pedId);
      ok('M14 entrega sem código de município é recusada com explicação',
        r.status === 422 && /código IBGE/.test(r.body.error), JSON.stringify(r.body));
      ok('M14b e nada foi transmitido', espiao.envios === 0, `envios=${espiao.envios}`);
    }

    /* ── M15: o endpoint que a TELA consulta ─────────────────────────────
     *
     * Este bloco existe porque a sabotagem o exigiu. Ao remover `!nfe55` do
     * cálculo de `podeEmitir`, a suíte inteira continuou verde: 145/145. O
     * painel ficaria oferecendo "Emitir NFC-e" num pedido que já tem NF-e 55,
     * e a emissão só falharia depois, na trava do servidor — sem risco
     * fiscal, mas induzindo o lojista ao erro, que é justamente o que o
     * desenho proíbe. O que não é medido não está protegido. */
    {
      const ler = (pedidoId) => chamar('GET', '/api/pedidos/:id/nfce', { id: String(pedidoId) });

      // Pedido limpo, tudo configurado: pode.
      cfgLoja(natNfce);
      const limpo = pedidoCatalogo();
      const a = await ler(limpo.pedId);
      ok('M15a pedido entregue e sem documento: podeEmitir', a.body.podeEmitir === true
        && a.body.naturezaOk === true, JSON.stringify(a.body));

      // Com NF-e 55 autorizada: NÃO pode, e a tela recebe o dado para explicar.
      const comNfe = pedidoCatalogo();
      db.prepare(`INSERT INTO faturas (numero, pedidoId, clienteId, dataEmissao, dataVencimento,
          valorBruto, valorFrete, valorDesconto, valorTotal, status, statusSefaz, chaveAcesso, numeroNFe)
        VALUES (?, ?, ?, '2026-09-28', '2026-10-28', 50, 0, 0, 50, 'emitida', 'autorizada', ?, 321)`)
        .run(`F55-${comNfe.num}`, comNfe.pedId, comNfe.pes, '3'.repeat(44));
      const b = await ler(comNfe.pedId);
      ok('M15b com NF-e 55 autorizada: NÃO podeEmitir', b.body.podeEmitir === false,
        JSON.stringify(b.body).slice(0, 200));
      ok('M15c e a tela recebe qual é a NF-e, para poder explicar',
        b.body.nfe55 && b.body.nfe55.numeroNFe === 321);

      // Natureza ausente: não pode, e a tela sabe por quê.
      cfgLoja(null);
      const c = await ler(limpo.pedId);
      ok('M15d sem natureza: NÃO podeEmitir, e naturezaOk é false',
        c.body.podeEmitir === false && c.body.naturezaOk === false);
      cfgLoja(natNfce);

      // Estado cedo demais.
      const cedo = pedidoCatalogo({ status: 'confirmado' });
      const e = await ler(cedo.pedId);
      ok('M15e pedido confirmado: NÃO podeEmitir', e.body.podeEmitir === false);

      // Já autorizada: não oferece emitir de novo.
      reset();
      const emitido = pedidoCatalogo();
      await emitirPeloPedido(emitido.pedId);
      const f = await ler(emitido.pedId);
      ok('M15f com NFC-e autorizada: NÃO podeEmitir', f.body.podeEmitir === false);
      ok('M15g e a tela recebe a nota para mostrar as ações',
        f.body.nfce && f.body.nfce.statusSefaz === 'autorizada');

      // Pendente: a tela precisa saber que é hora de consultar, não de emitir.
      const pend = pedidoCatalogo();
      db.prepare(`INSERT INTO nfce (numero, serie, chaveAcesso, tpAmb, valorProdutos,
        valorDesconto, valorTotal, statusSefaz, pedidoId)
        VALUES (6666, 1, ?, 2, 50, 0, 50, 'pendente', ?)`).run('6'.repeat(44), pend.pedId);
      const g = await ler(pend.pedId);
      ok('M15h com nota pendente: NÃO podeEmitir e precisaConsultar',
        g.body.podeEmitir === false && g.body.precisaConsultar === true, JSON.stringify(g.body));

      // Rejeitada e cancelada liberam nova emissão.
      for (const st of ['rejeitada', 'cancelada']) {
        const p = pedidoCatalogo();
        db.prepare(`INSERT INTO nfce (numero, serie, chaveAcesso, tpAmb, valorProdutos,
          valorDesconto, valorTotal, statusSefaz, pedidoId)
          VALUES (5555, 1, ?, 2, 50, 0, 50, ?, ?)`)
          .run(String(seq).padStart(44, '4'), st, p.pedId);
        const h = await ler(p.pedId);
        ok(`M15i nota ${st} libera nova emissão`, h.body.podeEmitir === true,
          JSON.stringify(h.body).slice(0, 160));
      }
    }
  }

  // ── N. cancelar o PEDIDO com documento fiscal no ar (Etapa 6) ────────────
  // O cancelamento estorna estoque, libera reserva e reabre a numeração.
  // Fazer isso com uma NFC-e válida na SEFAZ deixaria o ERP e o fisco
  // dizendo coisas diferentes sobre a mesma venda.
  {
    const appPed = { get(){}, post(){}, put(){}, delete(){}, use(){} };
    const rotasPed = new Map();
    const regP = (m) => (url, ...fns) => rotasPed.set(m + ' ' + url, fns[fns.length - 1]);
    Object.assign(appPed, { get: regP('GET'), post: regP('POST'), put: regP('PUT'),
                            delete: regP('DELETE') });
    let pedidosApi;
    try {
      require(path.join(RAIZ, 'reservas-routes')).registrarRotasReservas(appPed, db);
      pedidosApi = require(path.join(RAIZ, 'pedidos-routes'));
      pedidosApi.registrarRotasPedidos(appPed, db);
    } catch (e) {
      console.log(`  (não deu para registrar as rotas de pedidos: ${e.message})`);
    }

    const cancelar = (pedidoId, motivo) => {
      const fn = rotasPed.get('POST /api/pedidos/:id/cancelar');
      if (!fn) throw new Error('rota de cancelamento não registrada');
      let corpo = null, status = 200;
      const res = { json: (d) => { corpo = d; return res; },
                    status: (s) => { status = s; return res; } };
      fn({ params: { id: String(pedidoId) }, body: { motivo: motivo || 'teste de cancelamento' },
           query: {}, session: { username: 'suite' } }, res);
      return { status, body: corpo };
    };

    /** Um pedido ENTREGUE de verdade: com reserva consumida e saída de estoque. */
    function pedidoEntregue() {
      const prodId = produto();
      db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, data)
        VALUES (?, 'entrada', 100, '2026-09-01')`).run(prodId);
      const pes = db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, ativo, semDocumento)
        VALUES (?, 'PF', 'CLIENTE CANCEL', 1, 0)`).run(String(60000000000 + (++seq))).lastInsertRowid;
      const num = `CNL-${Date.now()}-${seq}`;
      const pedId = db.prepare(`INSERT INTO pedidos
          (numero, tipo, modoDocumento, clienteId, status, dataPedido, meioPagamento,
           tipoAtendimento, valorFrete, descontoAplicado, valorTotal, tipoOperacaoId)
        VALUES (?, 'catalogo', 'pedido', ?, 'entregue', '2026-09-28', '17', 'retirada', 0, 0, 50, ?)`)
        .run(num, pes, natureza.id).lastInsertRowid;
      db.prepare(`INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
        VALUES (?, ?, 'ITEM CANCEL', 2, 25, 50)`).run(pedId, prodId);
      // A saída que o "entregar" teria feito — é ela que o cancelamento estornaria.
      db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, origem, origemId, data)
        VALUES (?, 'saida', 2, 'pedido', ?, '2026-09-28')`).run(prodId, pedId);
      return { pedId, prodId, pes, num };
    }

    const foto = (c) => ({
      status: db.prepare('SELECT status FROM pedidos WHERE id = ?').get(c.pedId).status,
      movs: db.prepare('SELECT COUNT(*) c FROM movimentacoes_estoque WHERE produtoId = ?').get(c.prodId).c,
      hist: db.prepare('SELECT COUNT(*) c FROM pedido_historico WHERE pedidoId = ?').get(c.pedId).c,
      cr: db.prepare('SELECT COUNT(*) c FROM contas_a_receber').get().c,
      reservas: db.prepare('SELECT COUNT(*) c FROM reservas_estoque WHERE pedidoId = ?').get(c.pedId).c,
    });

    const notaDoPedido = (pedId, st) => db.prepare(`INSERT INTO nfce (numero, serie, chaveAcesso,
      tpAmb, valorProdutos, valorDesconto, valorTotal, statusSefaz, pedidoId)
      VALUES (?, 1, ?, 2, 50, 0, 50, ?, ?)`)
      .run(4000 + (++seq), String(seq).padStart(44, '8'), st, pedId).lastInsertRowid;

    // ── N1: sem NFC-e, o cancelamento continua funcionando como sempre
    {
      const c = pedidoEntregue();
      const antes = foto(c);
      const r = cancelar(c.pedId);
      const depois = foto(c);
      ok('N1 pedido sem NFC-e cancela normalmente', r.status === 200 && r.body.success === true,
        JSON.stringify(r.body));
      ok('N1b o estorno de estoque aconteceu', depois.movs > antes.movs,
        `${antes.movs} → ${depois.movs}`);
      ok('N1c o status virou cancelado', depois.status === 'cancelado');
      ok('N1d o histórico registrou', depois.hist > antes.hist);
    }

    // ── N2 e N3: rejeitada e cancelada NÃO barram
    for (const st of ['rejeitada', 'cancelada']) {
      const c = pedidoEntregue();
      notaDoPedido(c.pedId, st);
      const r = cancelar(c.pedId);
      ok(`N2.${st} NFC-e ${st} não bloqueia o cancelamento`,
        r.status === 200 && r.body.success === true, JSON.stringify(r.body));
      ok(`N2.${st} e o pedido foi mesmo cancelado`,
        db.prepare('SELECT status FROM pedidos WHERE id = ?').get(c.pedId).status === 'cancelado');
    }

    // ── N4: autorizada BARRA, e nada é tocado
    {
      const c = pedidoEntregue();
      notaDoPedido(c.pedId, 'autorizada');
      const antes = foto(c);
      const r = cancelar(c.pedId);
      const depois = foto(c);

      ok('N4 NFC-e autorizada bloqueia o cancelamento', r.status === 409 && !r.body.success,
        JSON.stringify(r.body));
      ok('N4b a mensagem é a que o lojista precisa ler',
        /NFC-e autorizada/.test(r.body.error) && /Cancele primeiro o documento fiscal/.test(r.body.error),
        r.body.error);
      ok('N4c a mensagem diz QUAL nota', /nº \d+/.test(r.body.error), r.body.error);

      /* Estas cinco são o coração da etapa: o bloqueio tem de acontecer
         ANTES de qualquer efeito, e não no meio de uma transação desfeita. */
      ok('N4d estoque intocado', depois.movs === antes.movs, `${antes.movs} → ${depois.movs}`);
      ok('N4e financeiro intocado', depois.cr === antes.cr, `${antes.cr} → ${depois.cr}`);
      ok('N4f reservas intocadas', depois.reservas === antes.reservas);
      ok('N4g status do pedido permanece', depois.status === antes.status
        && depois.status === 'entregue', `virou ${depois.status}`);
      ok('N4h histórico NÃO recebeu cancelamento', depois.hist === antes.hist,
        `${antes.hist} → ${depois.hist}`);
    }

    // ── N5: pendente também barra. Escolha deliberada.
    {
      const c = pedidoEntregue();
      notaDoPedido(c.pedId, 'pendente');
      const antes = foto(c);
      const r = cancelar(c.pedId);
      const depois = foto(c);
      ok('N5 NFC-e pendente também bloqueia (ela pode estar autorizada na SEFAZ)',
        r.status === 409 && !r.body.success, JSON.stringify(r.body));
      ok('N5b e manda CONSULTAR antes', /Consulte a situação/.test(r.body.error), r.body.error);
      ok('N5c nada foi tocado', depois.movs === antes.movs && depois.status === antes.status
        && depois.hist === antes.hist);
    }

    // ── N6: a nota autorizada de OUTRO pedido não atrapalha
    {
      const a = pedidoEntregue();
      const b = pedidoEntregue();
      notaDoPedido(a.pedId, 'autorizada');
      const r = cancelar(b.pedId);
      ok('N6 nota de outro pedido não bloqueia este',
        r.status === 200 && r.body.success === true, JSON.stringify(r.body));
    }

    // ── N7: a ação em MASSA passa pela mesma trava
    // Ela chama `cancelarPedidoInterno` direto — se a verificação estivesse
    // no handler da rota, este caminho ficaria desprotegido.
    {
      const c = pedidoEntregue();
      notaDoPedido(c.pedId, 'autorizada');
      const antes = foto(c);
      const fn = rotasPed.get('POST /api/pedidos/acao-massa');
      if (fn) {
        let corpo = null, status = 200;
        const res = { json: (d) => { corpo = d; return res; },
                      status: (s) => { status = s; return res; } };
        fn({ body: { acao: 'cancelar', ids: [c.pedId], motivo: 'teste em massa' },
             params: {}, query: {}, session: { username: 'suite' } }, res);
        const depois = foto(c);
        ok('N7 a ação em massa respeita a trava', depois.status === 'entregue',
          `virou ${depois.status} · ${JSON.stringify(corpo).slice(0, 160)}`);
        ok('N7b e não mexeu no estoque', depois.movs === antes.movs);
      } else {
        ok('N7 a rota de ação em massa existe', false, 'não registrada');
      }
    }

    // ── N8: a verificação está ANTES da transação, no fonte
    // Um caso passa mesmo com a ordem errada (a transação desfaria tudo), mas
    // a ordem errada gravaria no WAL e rodaria gatilhos à toa. A regra é ser
    // antes, e é isso que se mede.
    {
      const src = fs.readFileSync(path.join(RAIZ, 'pedidos-routes.js'), 'utf8');
      const i = src.indexOf('function cancelarPedidoInterno');
      const corpo = src.slice(i, i + 6000);
      const posTrava = corpo.indexOf("statusSefaz IN ('autorizada', 'pendente')");
      const posTx = corpo.indexOf('const tx = db.transaction');
      ok('N8 a trava fiscal existe no cancelamento do pedido', posTrava > 0);
      ok('N8b e vem ANTES da transação', posTrava > 0 && posTx > 0 && posTrava < posTx,
        `trava@${posTrava} tx@${posTx}`);
    }
  }

  console.log(`\n${total - falhas}/${total} asserts passaram`);
  if (falhas) { console.log(`FALHA: ${falhas} problema(s)`); process.exit(1); }
  console.log('TODOS OS ASSERTS PASSARAM');
})().catch((e) => { console.error('FALHOU:', e.stack || e.message || e); process.exit(1); });
