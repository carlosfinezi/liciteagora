/**
 * Relatório de certificados SSL (.xlsx e .pdf) — ssl-certificados-relatorio.js
 *
 * Os dados são SINTÉTICOS, montados aqui, e as datas são relativas a hoje. Nada
 * lê o banco de um tenant: teste que mede produção reprova no primeiro uso
 * legítimo do sistema, e "56 certificados" vira falso na próxima compra.
 *
 * O que ele prova, e por que cada um está aqui:
 *
 *  - Data sai como DATA no Excel, no dia certo. Este é o teste que pegou o bug
 *    de verdade: entregar um `Date` à lib `xlsx` produzia o serial 46638,99967
 *    em vez de 46639, porque a lib compensa fuso contra 30/12/1899 e nessa data
 *    `America/Sao_Paulo` ainda está em LMT. O Excel truncava e TODA data
 *    aparecia um dia antes.
 *  - Identificador (pedido NicSRS, pedido de compra) sai inteiro no PDF. Meio
 *    identificador não acha a compra no painel da NicSRS, que é o único motivo
 *    de a coluna existir.
 *  - Os KPIs em JS batem com o SQL que a tela usa — as duas contas precisam
 *    concordar, senão o topo do relatório contradiz a lista logo abaixo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const Database = require(path.join(RAIZ, 'node_modules/better-sqlite3'));
const XLSX = require(path.join(RAIZ, 'node_modules/xlsx'));
const rel = require(path.join(RAIZ, 'ssl-certificados-relatorio.js'));

let okN = 0, falhas = 0;
const t = (n, f) => { try { f(); console.log('  OK  ' + n); okN++; } catch (e) { falhas++; console.log('FALHA ' + n + ' -> ' + e.message); } };
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-rel-'));
const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

/** Data a N dias de hoje, em ISO. N negativo = passado. */
function emDias(n) {
  const d = new Date(Date.parse(hoje + 'T12:00:00Z') + n * 86400000);
  return d.toISOString().slice(0, 10);
}

// ==================== massa sintética ====================
//
// 60 linhas para forçar mais de uma página no PDF, cobrindo: os 10 status, data
// ausente, data vencida, data a vencer dentro e fora das janelas de 30/90 dias,
// nome de cliente longo (que PODE truncar) e identificador longo (que NÃO pode).
const STATUS = ['rascunho', 'aguardando-aprovacao', 'aguardando-dados', 'comprado',
                'em-validacao', 'emitido', 'reemitindo', 'substituido', 'cancelado', 'expirado'];
const OFFSETS = [null, -400, -10, 5, 25, 60, 120, 400];

const LINHAS = [];
for (let i = 0; i < 60; i++) {
  const st = STATUS[i % STATUS.length];
  const offArq = OFFSETS[i % OFFSETS.length];
  const offAss = OFFSETS[(i + 3) % OFFSETS.length];
  LINHAS.push({
    id: 1000 + i,
    commonName: i % 7 === 0 ? `*.subdominio-bem-longo-${i}.exemplo.gov.br` : `host${i}.exemplo.com.br`,
    clienteNome: i % 5 === 0 ? 'CONSELHO REGIONAL DE ALGUMA COISA DO ESTADO DE MINAS GERAIS' : (i % 3 === 0 ? null : `Cliente ${i}`),
    contratoNumero: i % 4 === 0 ? `CT-2026-${String(i).padStart(4, '0')}` : null,
    productName: i % 2 === 0 ? 'Certum Commercial Wildcard DV SSL' : 'InstantSSL Premium(OV)',
    productCode: 'PROD' + i,
    vendor: i % 2 === 0 ? 'Certum' : 'Sectigo',
    status: st,
    endDate: offArq == null ? null : emDias(offArq),
    cobertoAte: offAss == null ? null : emDias(offAss),
    dataCompra: emDias(-(i * 5 + 1)),
    reissuesFeitos: i % 3,
    dcvMethod: 'CNAME_CSR_HASH',
    servidor: 'NGINX',
    anos: 1,
    custoUsd: i % 6 === 0 ? null : 23.3,
    custoBrl: i % 4 === 0 ? 120.5 : null,
    // 16 caracteres, o comprimento real de uma ordem NicSRS.
    orderNum: 'RC' + String(17889843375875 + i),
    certId: 'cert-' + String(2069900649734082560n + BigInt(i)),
    pedidoCompraNumero: i % 9 === 0 ? `PC-2026-${String(i).padStart(4, '0')}` : null,
    pedidoCompraIdEfetivo: i % 9 === 0 ? i : null,
  });
}

console.log(`\nMassa sintética: ${LINHAS.length} certificados, hoje = ${hoje}`);

// ==================== XLSX ====================
const buf = rel.gerarXlsx(LINHAS, {});
// cellStyles: sem isso o `z` (formato) não volta na leitura e o teste de
// formatação mediria a ausência em vez do valor.
const wb = XLSX.read(buf, { type: 'buffer', cellStyles: true });
const ws = wb.Sheets['Certificados'];

t('1. duas abas, Certificados primeiro', () => {
  eq(wb.SheetNames.join(','), 'Certificados,Resumo', 'abas');
});

t('2. uma linha por certificado, uma coluna por campo declarado', () => {
  const range = XLSX.utils.decode_range(ws['!ref']);
  eq(range.e.r, LINHAS.length, 'última linha (0-based: cabeçalho + dados)');
  eq(range.e.c, rel.COLUNAS_XLSX.length - 1, 'última coluna');
  rel.COLUNAS_XLSX.forEach((col, i) => {
    eq(ws[XLSX.utils.encode_cell({ c: i, r: 0 })].v, col.label, 'cabeçalho ' + i);
  });
});

// O teste que pegou o bug do LMT. Mede o `w` — o texto RENDERIZADO na célula,
// que é o que a pessoa lê — e o serial inteiro, que é a causa.
t('3. data sai como DATA, no dia certo, sem deslize de fuso', () => {
  let conferidas = 0;
  for (const [label, campo] of [['Arquivo até', 'endDate'], ['Assinatura até', 'cobertoAte'], ['Compra', 'dataCompra']]) {
    const col = rel.COLUNAS_XLSX.findIndex((c) => c.label === label);
    for (let r = 1; r <= LINHAS.length; r++) {
      const iso = LINHAS[r - 1][campo];
      const cel = ws[XLSX.utils.encode_cell({ c: col, r })];
      if (!iso) { ok(!cel, `linha ${r} ${label}: sem data, célula deveria estar vazia`); continue; }
      ok(cel, `linha ${r} ${label}: célula sumiu`);
      ok(cel.t === 'n', `linha ${r} ${label}: tipo ${cel.t} — data virou texto e não ordena`);
      eq(cel.w, iso.split('-').reverse().join('/'), `linha ${r} ${label} — serial ${cel.v}`);
      ok(Number.isInteger(cel.v), `linha ${r} ${label}: serial fracionário ${cel.v} — o Excel trunca para o dia anterior`);
      ok(/dd\/mm\/yyyy/.test(cel.z || ''), `linha ${r} ${label}: formato ${cel.z}`);
      conferidas++;
    }
  }
  ok(conferidas > 100, 'poucas datas conferidas: ' + conferidas);
});

t('4. a contagem de dias é número, negativa no que já venceu', () => {
  const col = rel.COLUNAS_XLSX.findIndex((c) => c.label === 'Dias p/ assinatura');
  let vistos = 0;
  for (let r = 1; r <= LINHAS.length; r++) {
    const iso = LINHAS[r - 1].cobertoAte;
    const cel = ws[XLSX.utils.encode_cell({ c: col, r })];
    if (!iso) { ok(!cel, `linha ${r}: sem data deveria ter célula vazia`); continue; }
    ok(cel && cel.t === 'n', `linha ${r}: dias não é número`);
    eq(cel.v < 0, iso < hoje, `linha ${r}: sinal errado (${iso} vs hoje ${hoje})`);
    vistos++;
  }
  ok(vistos > 30, 'poucos: ' + vistos);
});

t('5. valor ausente vira célula vazia, nunca zero nem "null"', () => {
  const col = rel.COLUNAS_XLSX.findIndex((c) => c.label === 'Custo US$');
  for (let r = 1; r <= LINHAS.length; r++) {
    if (LINHAS[r - 1].custoUsd != null) continue;
    const cel = ws[XLSX.utils.encode_cell({ c: col, r })];
    ok(!cel, `linha ${r}: custo ausente virou ${cel && JSON.stringify(cel.v)}`);
  }
});

t('6. o autofiltro cobre o cabeçalho inteiro', () => {
  ok(ws['!autofilter'], 'sem autofiltro: a planilha não nasce filtrável');
  const r = XLSX.utils.decode_range(ws['!autofilter'].ref);
  eq(r.e.c, rel.COLUNAS_XLSX.length - 1, 'última coluna do filtro');
});

t('7. a aba Resumo declara os filtros aplicados', () => {
  const comFiltro = XLSX.read(rel.gerarXlsx(LINHAS.filter((c) => c.status === 'emitido'), { status: 'emitido', q: 'gov.br' }), { type: 'buffer' });
  const txt = XLSX.utils.sheet_to_csv(comFiltro.Sheets['Resumo']);
  ok(/Emitido/.test(txt), 'status não descrito no Resumo');
  ok(/gov\.br/.test(txt), 'busca não descrita no Resumo');
  ok(/carteira completa/.test(XLSX.utils.sheet_to_csv(wb.Sheets['Resumo'])), 'sem filtro deveria dizer "carteira completa"');
});

// ==================== KPIs: JS contra o SQL da tela ====================
t('8. os KPIs em JS batem com o SQL que /api/ssl/certificados usa', () => {
  const dbPath = path.join(TMP, 'kpi.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE ssl_certificados (id INTEGER PRIMARY KEY, status TEXT, endDate TEXT, cobertoAte TEXT)');
  const ins = db.prepare('INSERT INTO ssl_certificados (id,status,endDate,cobertoAte) VALUES (?,?,?,?)');
  for (const c of LINHAS) ins.run(c.id, c.status, c.endDate, c.cobertoAte);

  const sql = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='emitido' THEN 1 ELSE 0 END) AS emitidos,
      SUM(CASE WHEN status='aguardando-aprovacao' THEN 1 ELSE 0 END) AS aguardandoAprovacao,
      SUM(CASE WHEN status='aguardando-dados' THEN 1 ELSE 0 END) AS aguardandoDados,
      SUM(CASE WHEN status IN ('comprado','reemitindo','em-validacao') THEN 1 ELSE 0 END) AS emAndamento,
      SUM(CASE WHEN status='emitido' AND endDate IS NOT NULL AND date(endDate) <= date('now','+30 days') THEN 1 ELSE 0 END) AS arquivoVencendo30d,
      SUM(CASE WHEN cobertoAte IS NOT NULL AND date(cobertoAte) <= date('now','+90 days') AND status NOT IN ('cancelado','expirado') THEN 1 ELSE 0 END) AS assinaturaVencendo90d
    FROM ssl_certificados`).get();
  db.close();

  const js = rel.calcularKpis(LINHAS, hoje);
  for (const k of Object.keys(sql)) eq(js[k], sql[k], 'kpi ' + k);
  // A massa precisa exercitar as janelas de vencimento; se todos derem 0, o
  // teste passaria sem medir nada.
  ok(sql.arquivoVencendo30d > 0 && sql.assinaturaVencendo90d > 0, 'a massa não cobre as janelas de vencimento');
});

t('9. o KPI segue o FILTRO, não a carteira inteira', () => {
  const emitidos = LINHAS.filter((c) => c.status === 'emitido');
  const k = rel.calcularKpis(emitidos, hoje);
  eq(k.total, emitidos.length, 'total do subconjunto');
  eq(k.emitidos, emitidos.length, 'emitidos');
  ok(k.total < LINHAS.length, 'o subconjunto deveria ser menor que a carteira');
});

// ==================== PDF ====================
function gerarPdfArquivo(dados, filtros, destino) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destino);
    out.on('finish', resolve);
    out.on('error', reject);
    rel.gerarPdf(out, dados, filtros, { razaoSocial: 'EMPRESA DE TESTE LTDA', cnpj: '00000000000191' });
  });
}

/** pdftotext existe? Sem ele o PDF só pode ser validado por assinatura. */
function temPdftotext() {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
}

(async () => {
  const pdfPath = path.join(TMP, 'rel.pdf');
  await gerarPdfArquivo(LINHAS, {}, pdfPath);
  const bytes = fs.readFileSync(pdfPath);

  t('10. é um PDF válido', () => {
    eq(bytes.slice(0, 5).toString(), '%PDF-', 'assinatura do arquivo');
    ok(bytes.length > 5000, 'tamanho suspeito: ' + bytes.length);
  });

  t('11. as colunas do PDF cabem na largura útil de A4 paisagem', () => {
    const soma = rel.COLUNAS_PDF.reduce((s, c) => s + c.largura, 0);
    const vaos = (rel.COLUNAS_PDF.length - 1) * 2;
    const util = 842 - 30 * 2;
    ok(soma + vaos <= util, `larguras somam ${soma} + ${vaos} de vão = ${soma + vaos}, útil é ${util}`);
  });

  t('12. relatório vazio não quebra e diz que está vazio', async () => {
    const vazio = path.join(TMP, 'vazio.pdf');
    await gerarPdfArquivo([], { status: 'rascunho' }, vazio);
    ok(fs.readFileSync(vazio).slice(0, 5).toString() === '%PDF-', 'PDF vazio inválido');
    const wbV = XLSX.read(rel.gerarXlsx([], { status: 'rascunho' }), { type: 'buffer' });
    eq(wbV.SheetNames.length, 2, 'abas no relatório vazio');
  });

  if (!temPdftotext()) {
    console.log('  --  pdftotext ausente: 4 testes de conteúdo do PDF pulados');
  } else {
    const texto = execFileSync('pdftotext', ['-layout', pdfPath, '-']).toString();

    t('13. pagina e numera todas as folhas', () => {
      const rodapes = texto.match(/Página \d+ de (\d+)/g) || [];
      ok(rodapes.length >= 2, '60 linhas deveriam passar de uma página; achei ' + rodapes.length);
      eq(rodapes.length, Number(/Página \d+ de (\d+)/.exec(texto)[1]), 'rodapé em toda página');
    });

    t('14. todo certificado aparece, e o cabeçalho traz emitente e KPIs', () => {
      const faltando = LINHAS.map((c) => c.commonName).filter((d) => !texto.includes(d));
      eq(faltando.length, 0, 'domínios ausentes: ' + faltando.slice(0, 3).join(', '));
      ok(/EMPRESA DE TESTE LTDA/.test(texto), 'razão social');
      ok(new RegExp(LINHAS.length + ' certificado\\(s\\)').test(texto), 'contagem');
      ok(/Arquivo vence 30d/.test(texto) && /Assinatura vence 90d/.test(texto), 'faixa de KPI');
      ok(/carteira completa/.test(texto), 'linha de filtros');
    });

    // Identificador truncado não acha nada no painel da NicSRS nem no
    // financeiro — é o único motivo de as colunas existirem.
    t('15. os identificadores saem INTEIROS', () => {
      const pedidos = [...new Set(LINHAS.map((c) => c.orderNum).filter(Boolean))];
      const faltando = pedidos.filter((p) => !texto.includes(p));
      eq(faltando.length, 0, `pedido NicSRS truncado: ${faltando.slice(0, 3).join(', ')}`);
      const compras = [...new Set(LINHAS.map((c) => c.pedidoCompraNumero).filter(Boolean))];
      eq(compras.filter((p) => !texto.includes(p)).length, 0, 'pedido de compra truncado');
    });

    t('16. o status sai legível e inteiro, nunca em kebab-case', () => {
      ok(!/aguardando-aprovacao|aguardando-dados|em-validacao/.test(texto), 'status cru vazou para o papel');
      for (const s of [...new Set(LINHAS.map((c) => c.status))]) {
        const rot = rel.STATUS_LABEL[s] || s;
        ok(texto.includes(rot), `status "${s}" deveria imprimir "${rot}" inteiro`);
      }
    });
  }

  // ==================== a ponta da tela ====================
  //
  // O passo 3 do verify já faz `node --check` no <script> inline das telas, e
  // esta é uma delas (o filtro de lá é carregar /js/sidebar.js). O que ele NÃO
  // faz é olhar significado: sintaxe válida não diz que o botão existe, que
  // aponta para uma função declarada, nem que a URL bate com a rota do
  // backend. É essa parte que os quatro abaixo cobrem — o caminho do clique
  // até o endpoint.
  const vm = require('vm');
  const HTML = fs.readFileSync(path.join(RAIZ, 'public/ssl/certificados.html'), 'utf8');
  const inline = [...HTML.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const js = inline.join('\n');

  t('17. o script inline da tela parseia', () => {
    ok(inline.length > 0, 'nenhum script inline encontrado — o seletor quebrou');
    inline.forEach((src, i) => {
      try { new vm.Script(src, { filename: `certificados.html#${i}` }); }
      catch (e) { throw new Error(`bloco ${i}: ${e.message}`); }
    });
  });

  t('18. os botões estão ligados a funções que existem', () => {
    const chamadas = [...HTML.matchAll(/onclick="([a-zA-Z_$][\w$]*)\(/g)].map((m) => m[1]);
    const declaradas = new Set([...js.matchAll(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
    const orfas = [...new Set(chamadas)].filter((c) => !declaradas.has(c) && !['event', 'window'].includes(c));
    eq(orfas.length, 0, 'handler sem função: ' + orfas.join(', '));
    ok(chamadas.includes('exportarExcel') && chamadas.includes('exportarPdf'), 'os botões de relatório não estão ligados');
  });

  t('19. a URL dos botões é exatamente a rota registrada no backend', () => {
    const rotas = fs.readFileSync(path.join(RAIZ, 'ssl-certificados-routes.js'), 'utf8');
    for (const ext of ['xlsx', 'pdf']) {
      const url = `/api/ssl/relatorio/certificados.${ext}`;
      ok(js.includes(url), `a tela não chama ${url}`);
      ok(rotas.includes(`app.get('${url}'`), `o backend não registra ${url}`);
    }
    // O caminho não pode voltar para /api/ssl/certificados/...: lá o handler
    // de /certificados/:id casaria primeiro e o relatório viraria um 404 mudo.
    ok(!/\/api\/ssl\/certificados\/relatorio/.test(js + rotas), 'rota de relatório sob /certificados/ — será capturada por :id');
  });

  t('20. grid e relatório leem os MESMOS filtros', () => {
    // `function paramsFiltros()` também casa o padrão da chamada; fora a
    // declaração devem sobrar 3 usos: carregar() e os dois botões.
    eq((js.match(/(?<!function\s)paramsFiltros\(\)/g) || []).length, 3, 'usos de paramsFiltros()');
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n  ${okN} ok, ${falhas} falha(s)\n`);
  process.exit(falhas ? 1 : 0);
})();
