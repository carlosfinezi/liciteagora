/**
 * import-nicsrs-ssl-1bit.js — Importa catálogo de certificados SSL da NICSRS
 * no tenant 1bit. Cria fornecedor NICSRS (PJ estrangeiro sem CNPJ) e gera 75
 * produtos com SKU SSL-NICSRS-001..075. Sem coluna nova: garantia, tempo de
 * emissão, wildcard, multi-domínio e preço USD ficam em `observacoes`.
 *
 * Uso:
 *   node scripts/import-nicsrs-ssl-1bit.js          # dry-run, mostra preview
 *   node scripts/import-nicsrs-ssl-1bit.js --apply  # grava no banco
 */

const Database = require('better-sqlite3');

const DB_PATH = '/home/carlosfinezi/web/liciteagora.com.br/private/data/tenants/1bit/pncp.db';
const APPLY = process.argv.includes('--apply');

// Cotação consultada em 2026-05-15 (exchangerate-api.com)
const USD_BRL = 4.9931;

const PRODUTOS = [
  ['sslTrus BasicSSL', 5.00, '/', '5-10 minutes'],
  ['sslTrus BasicSSL Wildcard', 55.00, '/', '5-10 minutes'],
  ['sslTrus OV Multi-Domain/SAN SSL', 151.20, '$1,000,000', '1~3 days'],
  ['sslTrus Multi-Domain BasicSSL', 5.00, '/', '5-10 minutes'],
  ['Digicert DV Wildcard SSL', 153.00, 'NO', '5-10 minutes'],
  ['sslTrus DV Multi-Domain/SAN SSL', 18.00, '$500,000', '5-10 minutes'],
  ['sslTrus OV SSL Certificate', 50.40, '$1,000,000', '1-3 Days'],
  ['sslTrus OV Wildcard Certificate', 204.00, '$1,000,000', '1~3 days'],
  ['sslTrus EV SSL Certificate', 86.40, '$1,750,000', '1~3 days'],
  ['sslTrus EV Multi-Domain/SAN SSL', 259.20, '$1,750,000', '1~3 days'],
  ['GeoTrust QuickSSL Premium Wildcard', 128.10, '$500,000', '5-10 minutes'],
  ['GeoTrust DV Flex SSL', 31.50, '$500,000', '5-10 minutes'],
  ['GeoTrust DV Wildcard Flex SSL', 128.10, '$500,000', '5-10 minutes'],
  ['Thawte DV Wildcard Flex', 132.30, '$500,000', '5-10 minutes'],
  ['Thawte DV Flex SSL', 23.10, '$500,000', '5-10 minutes'],
  ['Thawte OV Flex SSL', 46.20, '$1,250,000', '1~3 days'],
  ['Thawte OV Wildcard Flex', 195.30, '$1,250,000', '1~3 days'],
  ['Thawte EV Flex SSL', 105.74, '$1,500,000', '3-5 days'],
  ['sslTrus DV SSL Certificate', 6.00, '$500,000', '5-10 minutes'],
  ['sslTrus DV Wildcard Certificate', 66.00, '$500,000', '5-10 minutes'],
  ['InstantSSL OV Wildcard', 149.00, '$250,000', '1~3 days'],
  ['InstantSSL Premium(OV)', 25.00, '$250,000', '1~3 days'],
  ['PositiveSSL OV Wildcard SSL', 170.00, '$500,000', '1~3 days'],
  ['PositiveSSL OV SSL', 42.00, '$500,000', '1~3 days'],
  ['PositiveSSL OV Multi Domain SSL', 79.50, '$500,000', '1-3 Days'],
  ['Sectigo EV SSL', 101.00, '$1,750,000', '1~5 days'],
  ['Sectigo EV Multi-Domain/UCC', 303.00, '$1,750,000', '1-5 days'],
  ['Sectigo OV SSL', 52.00, '$1,000,000', '1~3 days'],
  ['Sectigo OV Multi-Domain/UCC', 156.00, '$1,000,000', '1~3 days'],
  ['Sectigo OV Wildcard SSL', 240.00, '$1,000,000', '1~3 days'],
  ['Sectigo DV SSL', 29.75, '$500,000', '2-5 minutes'],
  ['Sectigo DV Multi-Domain SSL', 89.25, '$500,000', '2-5 minutes'],
  ['Sectigo DV Wildcard SSL', 135.00, '$500,000', '2-5 minutes'],
  ['Sectigo OV Multi-Domain Wildcard SSL', 480.00, '$1,000,000', '1~3 days'],
  ['SectigoSSL Premium OV Wildcard', 93.75, '$1,000,000', '1~3 days'],
  ['EssentialSSL DV SSL', 5.00, '$10,000', '2-5 minutes'],
  ['EssentialSSL DV Wildcard SSL', 37.00, '$10,000', '2-5 minutes'],
  ['PositiveSSL EV SSL', 72.00, '$1,000,000', '1-5 days'],
  ['PositiveSSL EV Multi-Domain', 216.00, '$1,000,000', '1-5 days'],
  ['PositiveSSL DV', 5.00, '$50,000', '2-5 minutes'],
  ['PositiveSSL Multi-Domain (DV)', 15.00, '$50,000', '5-10 minutes'],
  ['PositiveSSL Wildcard (DV)', 55.00, '$50,000', '2-5 minutes'],
  ['PositiveSSL Multi-Domain Wildcard (DV)', 110.00, '$50,000', '5-10 minutes'],
  ['PositiveSSL DV Mixed Multi-Domain SSL', 15.00, '$50,000', 'Mere Minutes'],
  ['Sectigo DV Mixed Multi-Domain SSL', 89.25, '$500,000', '2-5 minutes'],
  ['Sectigo OV Mixed Multi-Domain SSL', 156.00, '$1,000,000', '1~3 days'],
  ['Digicert Basic EV Flex', 343.48, '$1,750,000', '1~3 days'],
  ['Digicert Basic OV Flex', 179.16, '$1,250,000', '1-3 days'],
  ['Digicert Basic OV Wildcard Flex', 569.07, '$1,250,000', '1~3 days'],
  ['Digicert Secure site EV Flex', 757.37, '$1,750,000', '1~3 days'],
  ['Digicert Secure site OV Flex', 430.22, '$1,750,000', '1~3 days'],
  ['Digicert Secure Site OV Wildcard Flex', 2391.05, '$1,750,000', '1~3 days'],
  ['Actalis SSL Server DV', 0.00, 'N/A', '5-10 minutes'],
  ['Actalis SSL Server DV Wildcard', 0.00, 'N/A', '5-10 minutes'],
  ['Actalis SSL Server SAN DV', 0.00, 'N/A', '5-10 minutes'],
  ['Actalis SSL Server OV', 0.00, 'N/A', '2~3 days'],
  ['Actalis SSL Server OV Wildcard', 0.00, 'N/A', '2~3 days'],
  ['Actalis SSL Server SAN OV', 0.00, 'N/A', '2~3 days'],
  ['Actalis SSL Server EV', 0.00, 'N/A', '3-5 days'],
  ['Actalis SSL Server SAN EV', 0.00, 'N/A', '3-5 days'],
  ['Digicert Secure site Pro EV Flex', 1223.14, '$2,000,000', '1~3 days'],
  ['Digicert Secure site Pro OV Flex', 753.40, '$2,000,000', '1~3 days'],
  ['Digicert Secure site Pro OV Wildcard Flex', 4474.83, '$2,000,000', '1~3 days'],
  ['GeoTrust True BusinessID EV Flex', 124.74, '$1,500,000', '1~5 days'],
  ['GeoTrust TrueBusiness ID OV Flex', 56.70, '$1,250,000', '1~3 days'],
  ['GeoTrust True BusinessID Wildcard Flex', 207.69, '$1,250,000', '1~3 days'],
  ['RapidSSL DV SSL', 8.55, '$10,000', '5-10 minutes'],
  ['RapidSSL Wildcard DV', 78.25, '$10,000', '5-10 minutes'],
  ['GlobalSign EV SSL', 165.00, '$1,500,000', '3-4 days'],
  ['GlobalSign OV SSL', 75.90, '$1,250,000', '1-3 days'],
  ['GlobalSign OV Wildcard SSL', 176.00, '$1,250,000', '1-3 days'],
  ['GlobalSign DV SSL', 41.80, '$100,000', '5-10 minutes'],
  ['GlobalSign DV Wildcard SSL', 118.80, '$100,000', '1-5 minutes'],
  ['GlobalSign AlphaSSL', 13.20, '$10,000', '5-10 minutes'],
  ['GlobalSign AlphaSSL Wildcard', 48.73, '$10,000', '5-10 minutes'],
];

function extrairMarca(nome) {
  const n = nome.toLowerCase();
  if (n.startsWith('ssltrus')) return 'sslTrus';
  if (n.startsWith('sectigossl') || n.startsWith('sectigo')) return 'Sectigo';
  if (n.startsWith('positivessl')) return 'PositiveSSL';
  if (n.startsWith('essentialssl')) return 'EssentialSSL';
  if (n.startsWith('instantssl')) return 'InstantSSL';
  if (n.startsWith('digicert')) return 'Digicert';
  if (n.startsWith('geotrust')) return 'GeoTrust';
  if (n.startsWith('thawte')) return 'Thawte';
  if (n.startsWith('rapidssl')) return 'RapidSSL';
  if (n.startsWith('globalsign')) return 'GlobalSign';
  if (n.startsWith('actalis')) return 'Actalis';
  return nome.split(/\s+/)[0];
}

function extrairTipo(nome) {
  const upper = nome.toUpperCase();
  if (/\bEV\b/.test(upper)) return 'EV';
  if (/\bOV\b/.test(upper)) return 'OV';
  if (/\bDV\b/.test(upper)) return 'DV';
  // Heurísticas pelos nomes sem sigla explícita
  if (/PREMIUM/.test(upper)) return 'OV';
  if (/QUICKSSL|ALPHASSL|BASICSSL|RAPIDSSL/.test(upper)) return 'DV';
  return '—';
}

function ehWildcard(nome) {
  return /wildcard/i.test(nome);
}

function ehMultiDominio(nome) {
  return /multi[\s-]?domain|\bSAN\b|\bUCC\b/i.test(nome);
}

function montarObservacoes(nome, precoUsd, garantia, tempo) {
  const tipo = extrairTipo(nome);
  const wildcard = ehWildcard(nome) ? 'Sim' : 'Não';
  const multi = ehMultiDominio(nome) ? 'Sim' : 'Não';
  const garantiaTxt = (!garantia || garantia === '/' || garantia === 'NO' || garantia === 'N/A')
    ? 'Sem garantia'
    : `${garantia} (em caso de violação do certificado)`;
  return [
    `Fornecedor: NICSRS (revenda internacional)`,
    `Tipo de validação: ${tipo}`,
    `Wildcard: ${wildcard}`,
    `Multi-domínio (SAN/UCC): ${multi}`,
    `Garantia: ${garantiaTxt}`,
    `Tempo de emissão: ${tempo}`,
    `Preço NICSRS: USD ${precoUsd.toFixed(2)} · cotação aplicada USD/BRL ${USD_BRL.toFixed(4)} (consultada em 2026-05-15, exchangerate-api.com)`,
  ].join('\n');
}

const db = new Database(DB_PATH);

const tx = db.transaction(() => {
  // 1) Garante fornecedor NICSRS
  let nicsrs = db.prepare("SELECT id FROM fornecedores WHERE cpfCnpj = ?").get('EX-NICSRS');
  if (!nicsrs) {
    if (APPLY) {
      const r = db.prepare(`INSERT INTO fornecedores
        (cpfCnpj, tipo, razaoSocial, nomeFantasia, observacoes, ativo)
        VALUES (?, 'PJ', ?, ?, ?, 1)`).run(
        'EX-NICSRS', 'NICSRS', 'NICSRS',
        'Fornecedor estrangeiro de certificados SSL (revenda multi-CA). CNPJ placeholder — preencher se aplicável.'
      );
      nicsrs = { id: r.lastInsertRowid };
      console.log(`[fornecedor] criado: id=${nicsrs.id}`);
    } else {
      nicsrs = { id: '?' };
      console.log('[fornecedor] seria criado: NICSRS (cpfCnpj=EX-NICSRS)');
    }
  } else {
    console.log(`[fornecedor] já existe: id=${nicsrs.id}`);
  }

  // 2) Insere produtos
  const ins = APPLY ? db.prepare(`INSERT INTO produtos
    (sku, descricao, unidade, precoCusto, precoVenda, categoria, marca,
     tipoProduto, fornecedorId, observacoes, ativo)
    VALUES (?, ?, 'UN', ?, 0, 'Certificado SSL', ?, 'SERVICO', ?, ?, 1)`) : null;

  let criados = 0, jaExistem = 0;
  const previewLinhas = [];

  PRODUTOS.forEach((p, i) => {
    const [nome, precoUsd, garantia, tempo] = p;
    const sku = `SSL-NICSRS-${String(i + 1).padStart(3, '0')}`;
    const marca = extrairMarca(nome);
    const precoBrl = +(precoUsd * USD_BRL).toFixed(2);
    const obs = montarObservacoes(nome, precoUsd, garantia, tempo);

    const existe = db.prepare('SELECT id FROM produtos WHERE sku = ?').get(sku);
    if (existe) { jaExistem++; return; }

    if (APPLY) {
      ins.run(sku, nome, precoBrl, marca, nicsrs.id, obs);
    }
    if (i < 3) previewLinhas.push({ sku, nome, marca, precoUsd, precoBrl, tipo: extrairTipo(nome), wildcard: ehWildcard(nome), multi: ehMultiDominio(nome), garantia });
    criados++;
  });

  console.log(`\n=== Preview (3 primeiros) ===`);
  previewLinhas.forEach(p => {
    console.log(`  ${p.sku} · ${p.nome}`);
    console.log(`    marca=${p.marca} · tipo=${p.tipo} · wildcard=${p.wildcard} · multi=${p.multi}`);
    console.log(`    custo: USD ${p.precoUsd.toFixed(2)} → BRL ${p.precoBrl.toFixed(2)} · garantia=${p.garantia}`);
  });

  console.log(`\n=== Resumo ===`);
  console.log(`Produtos a criar: ${criados}`);
  console.log(`Já existentes (SKU): ${jaExistem}`);
  console.log(`Cotação aplicada: USD/BRL ${USD_BRL.toFixed(4)}`);
  if (!APPLY) console.log('\n(dry-run · rode com --apply para gravar)');
});

tx();
db.close();
