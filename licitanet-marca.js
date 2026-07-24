// licitanet-marca.js — 2026-07-07
//
// Coletor da MARCA do vencedor no Licitanet. Diferente de BLL/BNC, o
// licitanet.com.br bloqueia o IP do servidor (403 em tudo), MAS o relatório
// "Extrato de Ata" é HTML público no CloudFront (dv7rs78smtpx8.cloudfront.net),
// que o servidor ALCANÇA. A marca vem estruturada nesse HTML.
//
// Divisão de trabalho (ver [[project_licitanet_marca_scraping]]):
//   - Electron do cliente (IP residencial + sessão) faz as 2 chamadas de API do
//     licitanet.com.br pra OBTER a URL do relatório no CloudFront:
//       POST /report/<processId>  {"relatorio":"RELATORIO_EXTRATO_ATA"}  -> {identifier}
//       GET  /report/<identifier>/download/2                             -> {url: cloudfront}
//   - ESTE módulo (servidor) baixa a URL do CloudFront, parseia e grava.
//
// O processId (ex 176262) o servidor deriva do nome do edital que o PNCP guarda
// (`<processId>_editais_*.zip` em /arquivos) — ver getProcessId().
//
// Join: a Especificação do item na ata bate com itens.descricao (mesma fonte, o
// edital); daí pega o numeroItem canônico e grava em resultados_bi.marcaFabricante.
//
// CLI (teste sem Electron, usando uma URL de ata já obtida):
//   node licitanet-marca.js --ata <cnpj> <ano> <seq> <ataUrl> [--dry]
//   node licitanet-marca.js --processid <cnpj> <ano> <seq>   (deriva do PNCP)

'use strict';

const axios = require('axios');
const unaccent = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
const catalogPg = require('./catalog-pg');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const PNCP_API = 'https://pncp.gov.br/api/pncp/v1';

// ─── util (compartilha a lógica do marca-portal-backfill) ──────────────────
function _norm(s) { return unaccent(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function _r2(v) {
  if (v == null) return null;
  let s = String(v).replace(/R\$|\s/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
const _MARCA_LIXO = new Set(['', '-', '.', 'ni', 'nao informado', 'sem marca', 'cf edital',
  'conforme edital', 'edital', 'a definir', 'servico', 'serviços', 'servicos', 'nan', 'null', 'propria']);
function _marcaValida(m) {
  const t = String(m || '').trim();
  if (t.length < 2) return false;
  const n = t.toLowerCase().replace(/\s+/g, ' ').trim();
  if (_MARCA_LIXO.has(n) || _MARCA_LIXO.has(_norm(t))) return false;
  if (/^cf\b|^conforme\b/i.test(n)) return false;
  return /[a-z0-9]/i.test(t);
}
function _unescapeHtml(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

// ─── parse do Extrato de Ata (HTML) ────────────────────────────────────────
// Estrutura: linhas "Empresa Vencedora: <NOME>" seguidas de tabela
// [Item, Status, Especificação, Un, Quant., Marca / Modelo, Valor Unit, Valor Total].
// A marca do vencedor está na 6ª coluna ("WD / SATA RED NAS"). CNPJ não aparece
// (só o nome da empresa) — o join é por descrição, não por fornecedor.
function _parseAta(htmlRaw) {
  const rows = htmlRaw.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const cells = (tr) => (tr.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [])
    .map(c => _unescapeHtml(c.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
  const itens = [];
  let vencedor = null;
  for (const tr of rows) {
    const c = cells(tr);
    if (!c.length) continue;
    const m = /Empresa Vencedora:\s*(.+)/i.exec(c[0]);
    if (m) { vencedor = m[1].trim() || (c[1] || '').trim(); continue; }
    // linha de item: 8 colunas, 1ª numérica, status HOMOLOGADO/ADJUDICADO
    if (c.length >= 8 && /^\d+$/.test(c[0]) && /HOMOLOG|ADJUDIC/i.test(c[1])) {
      const marcaModelo = c[5] || '';
      const [marca, ...modeloRest] = marcaModelo.split('/');
      itens.push({
        itemAta: parseInt(c[0], 10),
        vencedor,
        descr: c[2] || '',
        qtd: _r2(c[4]),
        marca: (marca || '').trim(),
        modelo: modeloRest.join('/').trim(),
        valorUnit: _r2(c[6]),
      });
    }
  }
  return itens;
}

// ─── mapeia por descrição → numeroItem e grava ─────────────────────────────
async function _mapearEGravar(cnpj, ano, sequencial, itensAta, { dryRun }) {
  // nossos itens (numeroItem canônico) + índice por descrição normalizada
  const our = new Map(); // normdesc -> {numeroItem, qtd}
  for (const r of await catalogPg.query(
    `SELECT i."numeroItem" ni, i."quantidade" q, replace(i."descricao", chr(9), ' ') d
       FROM itens i JOIN licitacoes l ON i."licitacaoId"=l."id"
      WHERE l."cnpj"=$1 AND l."anoCompra"=$2 AND l."sequencialCompra"=$3`, [cnpj, ano, sequencial])) {
    our.set(_norm(r.d), { numeroItem: String(r.ni), qtd: _r2(r.q) });
  }
  // vencedores atuais (só grava onde marca vazia)
  const marcaAtual = new Map();
  for (const r of await catalogPg.query(
    `SELECT "numeroItem" ni, "niFornecedor" forn, "marcaFabricante" marca, "modeloVersao" modelo FROM resultados_bi
      WHERE "cnpj"=$1 AND "ano"=$2 AND "sequencial"=$3 AND "niFornecedor"<>'__sem_resultado__'`,
    [cnpj, ano, sequencial])) {
    marcaAtual.set(String(r.ni), { forn: r.forn, marca: r.marca || '', modelo: r.modelo || '' });
  }

  const ourKeys = [...our.entries()];
  const claimed = new Set(); // um numeroItem não pode ser usado por 2 itens da ata
  const plano = [];
  for (const it of itensAta) {
    const k = _norm(it.descr);
    let hit = our.get(k);
    if (hit && claimed.has(hit.numeroItem)) hit = null; // exato já usado → tenta fallback
    if (!hit) { // fallback: prefixo 40 chars + qtd igual, numeroItem livre
      for (const [ok, ov] of ourKeys) {
        if (claimed.has(ov.numeroItem)) continue;
        if (k && ok.startsWith(k.slice(0, 40)) && (it.qtd == null || it.qtd === ov.qtd)) { hit = ov; break; }
      }
    }
    if (!hit) { plano.push({ ...it, numeroItem: null, motivo: 'sem match descrição' }); continue; }
    claimed.add(hit.numeroItem);
    const atual = marcaAtual.get(hit.numeroItem);
    // grava marca onde vazia (e válida) E/OU modelo onde vazio — nunca sobrescreve
    const gravaMarca = !!atual && !(atual.marca || '').trim() && _marcaValida(it.marca);
    const gravaModelo = !!atual && !(atual.modelo || '').trim() && (it.modelo || '').trim() !== '';
    const grava = gravaMarca || gravaModelo;
    plano.push({ ...it, numeroItem: hit.numeroItem, niFornecedor: atual && atual.forn, grava, gravaMarca, gravaModelo });
  }

  let gravados = 0;
  for (const p of plano) {
    if (!p.grava) continue;
    if (!dryRun) {
      await catalogPg.execute(
        `UPDATE resultados_bi SET
           "marcaFabricante" = CASE WHEN (("marcaFabricante" IS NULL OR "marcaFabricante"='') AND $5<>'') THEN $5 ELSE "marcaFabricante" END,
           "modeloVersao"    = CASE WHEN (("modeloVersao" IS NULL OR "modeloVersao"='') AND $7<>'') THEN $7 ELSE "modeloVersao" END,
           "dataCache"=now()
          WHERE "cnpj"=$1 AND "ano"=$2 AND "sequencial"=$3 AND "numeroItem"=$4 AND "niFornecedor"=$6`,
        [cnpj, ano, sequencial, p.numeroItem, p.gravaMarca ? p.marca : '', p.niFornecedor, p.gravaModelo ? p.modelo : '']);
    }
    gravados++;
  }
  return { itensAta: itensAta.length, mapeados: plano.filter(p => p.numeroItem).length, gravados, plano };
}

// ─── entrada principal: baixa a URL do CloudFront e processa ───────────────
async function processarAtaUrl({ cnpj, ano, sequencial, ataUrl, dryRun = false }) {
  if (!/cloudfront\.net\/reports\//.test(ataUrl)) {
    throw new Error('ataUrl deve ser o relatório do CloudFront (…/reports/pregao/…)');
  }
  const resp = await axios.get(ataUrl, { headers: { 'User-Agent': UA }, timeout: 30000, responseType: 'text' });
  const itens = _parseAta(_unescapeHtml(resp.data));
  if (itens.length === 0) return { status: 'sem_itens', itensAta: 0, gravados: 0 };
  const r = await _mapearEGravar(cnpj, ano, parseInt(sequencial, 10), itens, { dryRun });
  return { status: 'ok', ...r };
}

// processId do Licitanet = prefixo do nome do edital no PNCP (`<id>_editais_*.zip`)
async function getProcessId(cnpj, ano, sequencial) {
  const seq = String(sequencial).padStart(6, '0');
  const url = `${PNCP_API}/orgaos/${cnpj}/compras/${ano}/${seq}/arquivos`;
  const arqs = (await axios.get(url, { headers: { 'Accept': 'application/json' }, timeout: 15000 })).data || [];
  for (const a of arqs) {
    const m = /(\d{4,})_editais_/.exec(a.titulo || a.uri || '');
    if (m) return m[1];
  }
  return null;
}

module.exports = { processarAtaUrl, getProcessId, _parseAta, _marcaValida };

// ─── CLI ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const dry = args.includes('--dry');
    try {
      if (args.includes('--ata')) {
        const i = args.indexOf('--ata');
        const [cnpj, ano, seq, ataUrl] = [args[i + 1], args[i + 2], args[i + 3], args[i + 4]];
        const r = await processarAtaUrl({ cnpj, ano, sequencial: seq, ataUrl, dryRun: dry });
        console.log(`\n### ${cnpj}/${ano}/${seq} — status=${r.status} itensAta=${r.itensAta} mapeados=${r.mapeados} gravados=${r.gravados}${dry ? ' (DRY)' : ''}`);
        for (const p of (r.plano || []).sort((a, b) => (a.numeroItem || 0) - (b.numeroItem || 0))) {
          const tag = p.grava ? '✔grava' : (p.jaTem ? '·já tem' : (p.numeroItem ? '·pula' : '✗sem-item'));
          console.log(`  ata#${String(p.itemAta).padStart(3)} → numeroItem ${String(p.numeroItem || '—').padStart(9)}  ${tag.padEnd(9)} ${p.marca}${p.modelo ? ' / ' + p.modelo : ''}`);
        }
      } else if (args.includes('--processid')) {
        const i = args.indexOf('--processid');
        const pid = await getProcessId(args[i + 1], args[i + 2], args[i + 3]);
        console.log('processId Licitanet:', pid || '(não achado no PNCP)');
      } else {
        console.log('uso: node licitanet-marca.js --ata <cnpj> <ano> <seq> <ataUrl> [--dry]');
        console.log('     node licitanet-marca.js --processid <cnpj> <ano> <seq>');
      }
    } catch (e) { console.error('erro:', e.message); }
    finally { await catalogPg.close().catch(() => {}); }
  })();
}
