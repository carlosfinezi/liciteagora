/**
 * O que a node-sped-nfe entrega, e o que ela NÃO entrega, no modelo 65.
 *
 * Esta suíte não fala com a SEFAZ e não emite nada: ela monta XML em memória
 * e olha o resultado. Existe porque o Catálogo Online precisa de coisas que o
 * PDV nunca pediu — endereço de entrega, frete, troco, IBS/CBS — e cada uma
 * dessas pode estar implementada, faltando ou implementada errado na
 * biblioteca. Descobrir isso na rejeição da SEFAZ custa uma numeração
 * queimada; descobrir aqui custa dois segundos.
 *
 * Roda da raiz do projeto:  node scripts/test-nfce-lib-mod65.js
 */

const LIB = require.resolve('node-sped-nfe');

let falhas = 0;
let total = 0;
function ok(nome, condicao, detalhe) {
  total++;
  if (condicao) {
    console.log(`  ok   ${nome}`);
  } else {
    falhas++;
    console.log(`  FALHA ${nome}${detalhe ? ' — ' + detalhe : ''}`);
  }
}

/** NFC-e mínima e válida, no mesmo formato que o nfce-routes.js monta. */
function novaNota(Make, extras = {}) {
  const NFe = new Make();
  NFe.tagInfNFe({ Id: null, versao: '4.00' });
  NFe.tagIde({
    cUF: 15, cNF: '00000001', natOp: 'VENDA AO CONSUMIDOR',
    mod: extras.mod || '65',
    serie: 1, nNF: 1, dhEmi: '2026-09-28T10:00:00-03:00', tpNF: 1,
    idDest: 1, cMunFG: 1504208, tpImp: extras.mod === '55' ? 1 : 4,
    tpEmis: 1, cDV: 0, tpAmb: 2,
    finNFe: 1, indFinal: '1', indPres: extras.indPres || '1',
    procEmi: 0, verProc: 'LiciteAgora1.0',
  });
  NFe.tagEmit({ CNPJ: '12345678000199', xNome: 'LOJA', xFant: 'LOJA', IE: '123456789', CRT: '1' });
  NFe.tagEnderEmit({
    xLgr: 'AV BRASIL', nro: '100', xBairro: 'CENTRO', cMun: 1504208,
    xMun: 'MARABA', UF: 'PA', CEP: '68500000', cPais: '1058', xPais: 'BRASIL',
  });
  NFe.tagProd([{
    item: 1, cProd: 'S1', cEAN: 'SEM GTIN', xProd: 'TEMPERO', NCM: '09109900',
    CFOP: '5102', uCom: 'UN', qCom: '2.0000', vUnCom: '25.0000000000',
    vProd: '50.00', cEANTrib: 'SEM GTIN', uTrib: 'UN', qTrib: '2.0000',
    vUnTrib: '25.0000000000', indTot: 1,
  }]);
  NFe.tagProdICMSSN(0, { orig: '0', CSOSN: '102' });
  NFe.tagProdPIS(0, { CST: '49', vBC: '0.00', pPIS: '0.00', vPIS: '0.00' });
  NFe.tagProdCOFINS(0, { CST: '49', vBC: '0.00', pCOFINS: '0.00', vCOFINS: '0.00' });
  return NFe;
}

function fecharNota(NFe, opcoes = {}) {
  NFe.tagTotal({ ICMSTot: Object.assign({ vDesc: '0.00', vNF: '50.00' }, opcoes.ICMSTot || {}) });
  NFe.tagTransp({ modFrete: opcoes.modFrete === undefined ? 9 : opcoes.modFrete });
  NFe.tagDetPag([{ indPag: 0, tPag: '01', vPag: '50.00' }]);
  if (opcoes.vTroco !== undefined) NFe.tagTroco(opcoes.vTroco);
  return NFe.xml();
}

(async () => {
  const { Make } = await import(LIB);

  // ── A. IBS/CBS no modelo 65 ────────────────────────────────────────────────
  // A reforma tributária é opt-in (nfe_config.ibsCbsAtivo) e hoje nenhum tenant
  // a ligou. Quando ligar, a NFC-e tem de responder igual à NF-e 55, senão o
  // Catálogo Online emitiria sem os grupos novos.
  {
    const grupoIBSCBS = {
      CST: '000', cClassTrib: '000001',
      gIBSCBS: {
        vBC: '50.00',
        gIBSUF: { pIBSUF: '0.1000', vIBSUF: '0.05' },
        gIBSMun: { pIBSMun: '0.0000', vIBSMun: '0.00' },
        vIBS: '0.05',
        gCBS: { pCBS: '0.9000', vCBS: '0.45' },
      },
    };
    const saidas = {};
    for (const mod of ['55', '65']) {
      const NFe = novaNota(Make, { mod });
      let erro = null;
      try { NFe.tagProdIBSCBS(0, grupoIBSCBS); } catch (e) { erro = e.message || String(e); }
      ok(`A1.${mod} tagProdIBSCBS aceita o item no modelo ${mod}`, erro === null, erro);
      const xml = fecharNota(NFe);
      saidas[mod] = xml;
      const det = (xml.match(/<IBSCBS>[\s\S]*?<\/IBSCBS>/) || [''])[0];
      const tot = (xml.match(/<IBSCBSTot>[\s\S]*?<\/IBSCBSTot>/) || [''])[0];
      ok(`A2.${mod} grupo IBSCBS do item sai no XML`, det.includes('<vIBS>0.05</vIBS>'), det.slice(0, 80));
      ok(`A3.${mod} acumulador IBSCBSTot sai no XML`, tot.includes('<vBCIBSCBS>50.00</vBCIBSCBS>'), tot.slice(0, 80));
      ok(`A4.${mod} o acumulador somou o CBS do item`, tot.includes('<vCBS>0.45</vCBS>'), tot.slice(0, 120));
    }
    // A prova que interessa: o 65 não pode divergir do 55 na parte IBS/CBS.
    const soIBS = (x) => (x.match(/<IBSCBS>[\s\S]*?<\/IBSCBS>/) || [''])[0]
                       + (x.match(/<IBSCBSTot>[\s\S]*?<\/IBSCBSTot>/) || [''])[0];
    ok('A5 o bloco IBS/CBS do modelo 65 é idêntico ao do 55',
      soIBS(saidas['65']) === soIBS(saidas['55']));
  }

  // ── B. Endereço de entrega e de retirada ───────────────────────────────────
  // O Catálogo Online tem as duas modalidades. tagEntrega é o grupo <entrega>
  // do XML; se a lib não o implementa, o montador precisa injetar o trecho
  // depois da montagem e antes da assinatura, como farmacia/nfe-med-rastro.js
  // já faz com <med> e <rastro>.
  {
    const endereco = {
      xLgr: 'RUA DAS FLORES', nro: '250', xBairro: 'NOVO HORIZONTE',
      cMun: 1504208, xMun: 'MARABA', UF: 'PA', CEP: '68500000',
    };
    for (const [tag, nome] of [['tagEntrega', 'entrega'], ['tagRetirada', 'retirada']]) {
      const NFe = novaNota(Make);
      let erro = null;
      try { NFe[tag](endereco); } catch (e) { erro = e.message || String(e); }
      let noXml = false;
      if (!erro) {
        try { noXml = new RegExp(`<${nome}>`).test(fecharNota(NFe)); } catch (e) { erro = 'xml(): ' + e.message; }
      }
      // Sem asserção de valor: aqui só registro o que a lib faz, porque é isso
      // que decide se o montador precisa de injeção.
      console.log(`  info ${tag}: ${erro ? 'LANÇA "' + erro + '"' : (noXml ? `gera <${nome}>` : 'aceita mas não gera tag')}`);
    }
    // O que o montador vai poder usar tem de estar afirmado, não só informado.
    const NFeR = novaNota(Make);
    let erroR = null;
    try { NFeR.tagRetirada(endereco); } catch (e) { erroR = e.message || String(e); }
    ok('B1 tagRetirada está implementada', erroR === null, erroR);
    ok('B2 <retirada> sai no XML com o logradouro', !erroR && /<retirada>[\s\S]*RUA DAS FLORES/.test(fecharNota(NFeR)));

    const NFeE = novaNota(Make);
    let erroE = null;
    try { NFeE.tagEntrega(endereco); } catch (e) { erroE = e.message || String(e); }
    ok('B3 tagEntrega NÃO está implementada (o montador precisa injetar)',
      erroE !== null, 'a lib passou a implementar — reveja a injeção do montador');
  }

  // ── C. Troco ───────────────────────────────────────────────────────────────
  // O schema exige <detPag> antes de <vTroco> dentro de <pag>. A lib grava os
  // dois como chaves do mesmo objeto, então quem chama primeiro sai primeiro:
  // tagTroco antes de tagDetPag produz XML fora de ordem e rejeição 215.
  {
    const NFe = novaNota(Make);
    const xmlCerto = fecharNota(NFe, { vTroco: '5.00' }); // detPag e depois troco
    const pag = (xmlCerto.match(/<pag>[\s\S]*?<\/pag>/) || [''])[0];
    ok('C1 vTroco sai no XML', /<vTroco>5.00<\/vTroco>/.test(pag), pag);
    ok('C2 <detPag> vem antes de <vTroco>', pag.indexOf('<detPag>') < pag.indexOf('<vTroco>'), pag);

    const NFe2 = novaNota(Make);
    NFe2.tagTotal({ ICMSTot: { vDesc: '0.00', vNF: '50.00' } });
    NFe2.tagTransp({ modFrete: 9 });
    NFe2.tagTroco('5.00');                                  // ordem invertida
    NFe2.tagDetPag([{ indPag: 0, tPag: '01', vPag: '50.00' }]);
    const pag2 = (NFe2.xml().match(/<pag>[\s\S]*?<\/pag>/) || [''])[0];
    ok('C3 chamar tagTroco antes de tagDetPag INVERTE a ordem no XML',
      pag2.indexOf('<vTroco>') < pag2.indexOf('<detPag>'),
      'a lib passou a ordenar sozinha — a regra de ordem do montador virou desnecessária');
  }

  // ── D. Frete no total ──────────────────────────────────────────────────────
  // Entrega cobrada precisa de vFrete no ICMSTot; sem ele a soma não fecha
  // (rejeição 531) porque vNF inclui o frete e os componentes não.
  {
    const NFe = novaNota(Make);
    const xml = fecharNota(NFe, { modFrete: 0, ICMSTot: { vFrete: '12.00', vNF: '62.00' } });
    const tot = (xml.match(/<ICMSTot>[\s\S]*?<\/ICMSTot>/) || [''])[0];
    ok('D1 vFrete sai no ICMSTot', /<vFrete>12.00<\/vFrete>/.test(tot), tot.slice(0, 200));
    ok('D2 modFrete 0 (por conta do emitente) sai no XML', /<modFrete>0<\/modFrete>/.test(xml));
  }

  // ── E. Venda pela internet ─────────────────────────────────────────────────
  // O PDV emite com indPres=1 (presencial). Pedido do catálogo é indPres=2
  // (internet) — é o campo que distingue os dois no documento fiscal.
  {
    const xml = fecharNota(novaNota(Make, { indPres: '2' }));
    ok('E1 indPres=2 (internet) sai no XML', /<indPres>2<\/indPres>/.test(xml));
  }

  // ── F. QR Code e URL de consulta ───────────────────────────────────────────
  // O Make monta infNFeSupl com a URL base; o valor definitivo (com hash do
  // CSC) só é calculado no xmlSign. Quem lê o qrCode do XML NÃO assinado pega
  // a URL base sem parâmetros — foi por isso que a prova de fixture mostrou
  // uma URL nua.
  {
    const xml = fecharNota(novaNota(Make));
    const qr = (xml.match(/<qrCode>([\s\S]*?)<\/qrCode>/) || [])[1] || '';
    ok('F1 infNFeSupl existe no XML não assinado', /<infNFeSupl>/.test(xml));
    ok('F2 o qrCode do XML não assinado ainda NÃO tem o parâmetro ?p=',
      qr.length > 0 && !qr.includes('?p='),
      'a lib passou a montar o QR no xml() — reveja de onde o emissor lê o qrCodeUrl');
    ok('F3 urlChave sai no XML', /<urlChave>/.test(xml));
  }

  // ── G. URLs de webservice do modelo 65 ─────────────────────────────────────
  // consultarNFe (que é a base do retry seguro) troca a UF do PA por SVRS e
  // depois indexa por mod65. Se essa combinação não existir na tabela da lib,
  // a consulta estoura com TypeError em vez de responder.
  {
    const { urlEventos } = await import(
      require('path').join(require('path').dirname(LIB), 'utils/eventos.js'));
    for (const uf of ['PA', 'SVRS']) {
      const t = urlEventos(uf, '4.00');
      ok(`G1.${uf} a tabela tem mod65`, !!(t && t.mod65));
      for (const amb of ['homologacao', 'producao']) {
        const u = t.mod65[amb] || {};
        ok(`G2.${uf}.${amb} NFeConsultaProtocolo definida`, !!u.NFeConsultaProtocolo);
        ok(`G3.${uf}.${amb} NFeRecepcaoEvento definida (cancelamento)`, !!u.NFeRecepcaoEvento);
        ok(`G4.${uf}.${amb} NFeAutorizacao definida`, !!u.NFeAutorizacao);
      }
    }
    // O PA é quem tem a URL de consulta pública do QR Code; o SVRS não tem, e
    // não precisa ter — quem a usa é o Make, que indexa pela UF do emitente.
    ok('G5 PA tem NFeConsultaQR (o Make a usa para montar o infNFeSupl)',
      !!urlEventos('PA', '4.00').mod65.homologacao.NFeConsultaQR);
  }

  // ── H. DANFCe ──────────────────────────────────────────────────────────────
  // O PDF do cupom. O padrão é o mesmo da NF-e 55 em nfe-emit-routes.js:1143.
  {
    const { DANFCe } = await import('../vendor/node-sped-pdf/index.js');
    ok('H1 o vendor exporta DANFCe', typeof DANFCe === 'function');
    // Sem XML assinado real não dá para gerar o cupom completo, e nenhum dos
    // 19 tenants tem uma NFC-e emitida. A prova de que a função gera PDF a
    // partir de um XML foi feita à parte, com fixture; aqui basta o contrato.
    ok('H2 DANFCe é assíncrona (devolve Promise/Buffer)',
      DANFCe.constructor.name === 'AsyncFunction');
  }

  console.log(`\n${falhas === 0 ? 'TODOS OS' : ''} ${total - falhas}/${total} asserts passaram`);
  if (falhas) { console.log(`FALHA: ${falhas} problema(s)`); process.exit(1); }
  console.log('TODOS OS ASSERTS PASSARAM');
})().catch((e) => { console.error('FALHOU:', e.stack || e.message || e); process.exit(1); });
