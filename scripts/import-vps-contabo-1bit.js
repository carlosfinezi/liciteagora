/**
 * import-vps-contabo-1bit.js — Cria a linha de produtos "Hospedagem VPS" no
 * tenant 1bit, espelhando os planos Cloud VPS da Contabo (fornecedor de
 * revenda). Gera 12 produtos: 6 planos × 2 sistemas (Linux e Windows Server).
 *
 * Custo = preço mensal da Contabo convertido pela PTAX/BCB; nos planos Windows
 * soma a licença Windows Server (add-on mensal da própria Contabo).
 * Venda = custo × 3 (markupVenda = 200%).
 *
 * Sem coluna nova: vCPU, RAM, disco, tráfego, SO e o preço em euro ficam em
 * `observacoes`, no mesmo formato usado na importação NicSRS.
 *
 * Uso:
 *   node scripts/import-vps-contabo-1bit.js          # dry-run, mostra preview
 *   node scripts/import-vps-contabo-1bit.js --apply  # grava no banco
 */

const Database = require('better-sqlite3');

const DB_PATH = '/home/carlosfinezi/web/liciteagora.com.br/private/data/tenants/1bit/pncp.db';
const APPLY = process.argv.includes('--apply');

// PTAX/BCB (cotação de venda) de 2026-08-31
const EUR_BRL = 6.0189;
const COTACAO_DATA = '2026-08-31';

// Markup sobre o custo: 200% => venda = custo * 3
const MARKUP = 200;

// Licença Windows Server como add-on mensal da Contabo (contabo.com/en-us/windows-licenses/)
const LICENCA_WINDOWS_EUR = 4.99;

// Planos Cloud VPS da Contabo (contabo.com/en-us/vps/, consultado em 2026-08-31).
// eur = mensalidade do plano base, sem licença Windows.
const PLANOS = [
  { cod: 'S',   nome: 'Cloud VPS 4',  vcpu: 4,  ram: 8,  disco: 100, eur: 5.50 },
  { cod: 'M',   nome: 'Cloud VPS 6',  vcpu: 6,  ram: 12, disco: 200, eur: 7.50 },
  { cod: 'L',   nome: 'Cloud VPS 8',  vcpu: 8,  ram: 24, disco: 300, eur: 14.00 },
  { cod: 'XL',  nome: 'Cloud VPS 12', vcpu: 12, ram: 48, disco: 400, eur: 25.00 },
  { cod: 'XXL', nome: 'Cloud VPS 16', vcpu: 16, ram: 64, disco: 500, eur: 37.00 },
  { cod: 'MAX', nome: 'Cloud VPS 18', vcpu: 18, ram: 96, disco: 600, eur: 49.00 },
];

const SISTEMAS = [
  {
    slug: 'LNX',
    rotulo: 'Linux',
    so: 'Linux (Ubuntu, Debian, Rocky, AlmaLinux ou CentOS)',
    acesso: 'Acesso root via SSH',
    licencaEur: 0,
  },
  {
    slug: 'WIN',
    rotulo: 'Windows',
    so: 'Windows Server 2019 ou superior, licenciado',
    acesso: 'RDP administrativo',
    licencaEur: LICENCA_WINDOWS_EUR,
  },
];

function montarObservacoes(plano, sistema, custoEur, custoBrl) {
  const linhas = [
    'Fornecedor: Contabo (revenda internacional)',
    `Plano de origem: ${plano.nome}`,
    `Processador: ${plano.vcpu} vCPU`,
    `Memória: ${plano.ram} GB RAM`,
    `Armazenamento: ${plano.disco} GB SSD`,
    `Sistema operacional: ${sistema.so}`,
    `Acesso administrativo: ${sistema.acesso}`,
    'Endereço IP: 1 IPv4 dedicado',
    'Tráfego: ilimitado (política de uso justo)',
    'Backup: painel de backup com rotina diária',
    'Suporte: 24x7',
  ];
  if (sistema.licencaEur > 0) {
    linhas.push(
      `Preço Contabo: EUR ${plano.eur.toFixed(2)} (plano) + EUR ${sistema.licencaEur.toFixed(2)} `
      + `(licença Windows Server) = EUR ${custoEur.toFixed(2)}/mês`
    );
  } else {
    linhas.push(`Preço Contabo: EUR ${plano.eur.toFixed(2)}/mês`);
  }
  linhas.push(
    `Custo convertido pela PTAX/BCB de ${COTACAO_DATA}: R$ ${EUR_BRL.toFixed(4)} `
    + `→ R$ ${custoBrl.toFixed(2)}/mês`
  );
  linhas.push(`Preço de venda: custo + ${MARKUP}% de markup.`);
  linhas.push('Criado a partir da tabela pública da Contabo.');
  return linhas.join('\n');
}

const db = new Database(DB_PATH);

const tx = db.transaction(() => {
  // 1) Garante o fornecedor Contabo (PJ estrangeiro, sem CNPJ — mesmo padrão do NICSRS)
  let contabo = db.prepare('SELECT id FROM pessoas WHERE cpfCnpj = ?').get('EX-CONTABO');
  if (!contabo) {
    if (APPLY) {
      const r = db.prepare(`INSERT INTO pessoas
        (cpfCnpj, tipo, razaoSocial, nomeFantasia, categorias, observacoes, ativo)
        VALUES (?, 'PJ', ?, ?, ?, ?, 1)`).run(
        'EX-CONTABO', 'Contabo GmbH', 'Contabo', '["fornecedor"]',
        'Fornecedor estrangeiro de infraestrutura VPS. CNPJ placeholder — preencher se aplicável.'
      );
      contabo = { id: r.lastInsertRowid };
      console.log(`[fornecedor] criado: id=${contabo.id}`);
    } else {
      contabo = { id: '?' };
      console.log('[fornecedor] seria criado: Contabo (cpfCnpj=EX-CONTABO)');
    }
  } else {
    console.log(`[fornecedor] já existe: id=${contabo.id}`);
  }

  // 2) Insere produtos
  const ins = APPLY ? db.prepare(`INSERT INTO produtos
    (sku, descricao, unidade, precoCusto, precoVenda, markupVenda, categoria, marca,
     tipoProduto, tipoOrigemProduto, fornecedorId, observacoes, ativo)
    VALUES (?, ?, 'MES', ?, ?, ?, 'Hospedagem VPS', 'Contabo', 'SERVICO', 'revenda', ?, ?, 1)`) : null;

  let criados = 0, jaExistem = 0;
  const linhas = [];

  for (const sistema of SISTEMAS) {
    for (const plano of PLANOS) {
      const sku = `VPS-${sistema.slug}-${plano.cod}`;
      const custoEur = +(plano.eur + sistema.licencaEur).toFixed(2);
      const custoBrl = +(custoEur * EUR_BRL).toFixed(2);
      const vendaBrl = +(custoBrl * (1 + MARKUP / 100)).toFixed(2);
      const descricao = `VPS ${sistema.rotulo} ${plano.vcpu} vCPU / ${plano.ram} GB RAM / ${plano.disco} GB SSD`;
      const obs = montarObservacoes(plano, sistema, custoEur, custoBrl);

      const existe = db.prepare('SELECT id FROM produtos WHERE sku = ?').get(sku);
      if (existe) { jaExistem++; continue; }

      if (APPLY) {
        ins.run(sku, descricao, custoBrl, vendaBrl, MARKUP, contabo.id, obs);
      }
      linhas.push({ sku, descricao, custoEur, custoBrl, vendaBrl });
      criados++;
    }
  }

  // 3) Alimenta o autocomplete da tela de produtos (o POST /api/produtos faz
  // isso via registrarLookup; inserindo direto, é preciso replicar).
  if (APPLY && criados > 0) {
    const lookup = db.prepare('INSERT OR IGNORE INTO produto_lookup (tipo, valor) VALUES (?, ?)');
    lookup.run('categoria', 'Hospedagem VPS');
    lookup.run('marca', 'Contabo');
    lookup.run('unidade', 'MES');
  }

  console.log('\n=== Produtos ===');
  for (const l of linhas) {
    console.log(`  ${l.sku.padEnd(12)} ${l.descricao}`);
    console.log(`${''.padEnd(15)}custo EUR ${l.custoEur.toFixed(2)} → R$ ${l.custoBrl.toFixed(2)} · venda R$ ${l.vendaBrl.toFixed(2)}/mês`);
  }

  console.log('\n=== Resumo ===');
  console.log(`Cotação PTAX/BCB ${COTACAO_DATA}: R$ ${EUR_BRL.toFixed(4)} por EUR`);
  console.log(`Markup: ${MARKUP}% (venda = custo × ${(1 + MARKUP / 100).toFixed(0)})`);
  console.log(`Produtos a criar: ${criados}`);
  console.log(`Já existentes (SKU): ${jaExistem}`);
  if (!APPLY) {
    console.log('\nDRY-RUN — nada foi gravado. Rode com --apply para gravar.');
    throw new Error('__ROLLBACK_DRY_RUN__');
  }
});

try {
  tx();
  if (APPLY) console.log('\nGravado.');
} catch (err) {
  if (err.message !== '__ROLLBACK_DRY_RUN__') throw err;
}

db.close();
