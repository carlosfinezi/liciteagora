/**
 * fiscal-arquivamento-routes.js — Guarda e export de XMLs fiscais (obrigação 5 anos).
 *
 * Consolida XMLs de:
 *   - faturas.xmlAssinado (NF-e saída modelo 55)
 *   - nfe_entrada_inbox.xmlCompleto / nfe_entrada.xmlOriginal (NF-e entrada modelo 55)
 *   - nfse.xmlEnvio + xmlRetorno (NFSe Nacional)
 *
 * Endpoints:
 *   GET /api/fiscal/xmls/sumario?ano=YYYY
 *   GET /api/fiscal/xmls/export?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD&tipo=saida|entrada|nfse|todos
 */

const zlib = require('zlib');
let AdmZip;
try { AdmZip = require('adm-zip'); } catch { AdmZip = null; }

function safeCol(db, table, col) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(r => r.name === col);
  } catch { return false; }
}

function mesesDoAno(ano) {
  return Array.from({ length: 12 }, (_, i) => `${ano}-${String(i+1).padStart(2,'0')}`);
}

function sumarioAno(db, ano) {
  const inicio = `${ano}-01-01`;
  const fim = `${ano}-12-31`;

  const saida = db.prepare(`
    SELECT substr(dataEmissao, 1, 7) AS ym, COUNT(*) AS c
    FROM faturas
    WHERE xmlAssinado IS NOT NULL AND xmlAssinado != '' AND substr(dataEmissao,1,10) BETWEEN ? AND ?
    GROUP BY ym
  `).all(inicio, fim);

  const entrada = db.prepare(`
    SELECT substr(COALESCE(dataEmissao, dataDescoberta), 1, 7) AS ym, COUNT(*) AS c
    FROM nfe_entrada_inbox
    WHERE (xmlCompleto IS NOT NULL OR xmlResumo IS NOT NULL)
      AND substr(COALESCE(dataEmissao, dataDescoberta), 1, 10) BETWEEN ? AND ?
    GROUP BY ym
  `).all(inicio, fim);

  const nfse = db.prepare(`
    SELECT substr(COALESCE(dataCompetencia, substr(dataCriacao,1,7)), 1, 7) AS ym, COUNT(*) AS c
    FROM nfse
    WHERE (xmlEnvio IS NOT NULL OR xmlRetorno IS NOT NULL)
      AND (dataCompetencia BETWEEN ? AND ? OR substr(dataCriacao,1,10) BETWEEN ? AND ?)
    GROUP BY ym
  `).all(inicio.slice(0,7), fim.slice(0,7), inicio, fim);

  const meses = mesesDoAno(ano);
  const byMes = {};
  for (const ym of meses) byMes[ym] = { saida: 0, entrada: 0, nfse: 0 };
  for (const r of saida) if (byMes[r.ym]) byMes[r.ym].saida = r.c;
  for (const r of entrada) if (byMes[r.ym]) byMes[r.ym].entrada = r.c;
  for (const r of nfse) if (byMes[r.ym]) byMes[r.ym].nfse = r.c;

  const totais = meses.reduce((acc, ym) => {
    acc.saida += byMes[ym].saida;
    acc.entrada += byMes[ym].entrada;
    acc.nfse += byMes[ym].nfse;
    return acc;
  }, { saida: 0, entrada: 0, nfse: 0 });

  return { ano, meses: meses.map(ym => ({ ym, ...byMes[ym] })), totais };
}

function descomprimir(possivelBase64) {
  if (!possivelBase64) return null;
  const raw = String(possivelBase64);
  if (raw.startsWith('<?xml') || raw.startsWith('<')) return raw;
  try {
    const buf = Buffer.from(raw, 'base64');
    try {
      const gunzipped = zlib.gunzipSync(buf);
      return gunzipped.toString('utf-8');
    } catch {
      const s = buf.toString('utf-8');
      if (s.includes('<?xml') || s.startsWith('<')) return s;
      return raw;
    }
  } catch {
    return raw;
  }
}

// O retorno da NFSe Nacional (SEFIN) é gravado como JSON, com a NFSe autorizada
// (o XML que gera o DANFSE) gzipada+base64 no campo `nfseXmlGZipB64`. Extrai o
// <NFSe> real; se o retorno já for XML (provedores antigos), devolve como veio.
function extrairNfseAutorizada(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.startsWith('<') && (s.includes('<NFSe') || s.includes(':NFSe'))) return s;
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      if (j && j.nfseXmlGZipB64) {
        return zlib.gunzipSync(Buffer.from(j.nfseXmlGZipB64, 'base64')).toString('utf-8');
      }
    } catch { /* não-json ou sem o campo — cai no null */ }
  }
  return null;
}

function coletarSaida(db, inicio, fim) {
  const rows = db.prepare(`
    SELECT id, chaveAcesso, numeroNFe, serieNFe, dataEmissao, xmlAssinado
    FROM faturas
    WHERE xmlAssinado IS NOT NULL AND xmlAssinado != '' AND substr(dataEmissao,1,10) BETWEEN ? AND ?
    ORDER BY dataEmissao ASC
  `).all(inicio, fim);
  return rows.map(r => ({
    tipo: 'saida',
    competencia: (r.dataEmissao || '').slice(0, 7),
    nome: `${r.chaveAcesso || ('FAT-' + r.id)}.xml`,
    xml: descomprimir(r.xmlAssinado)
  })).filter(x => x.xml);
}

function coletarEntrada(db, inicio, fim) {
  const rows = db.prepare(`
    SELECT chaveAcesso, dataEmissao, dataDescoberta, xmlCompleto, xmlResumo
    FROM nfe_entrada_inbox
    WHERE (xmlCompleto IS NOT NULL OR xmlResumo IS NOT NULL)
      AND substr(COALESCE(dataEmissao, dataDescoberta), 1, 10) BETWEEN ? AND ?
    ORDER BY dataEmissao ASC
  `).all(inicio, fim);
  const out = [];
  for (const r of rows) {
    const ref = (r.dataEmissao || r.dataDescoberta || '').slice(0, 7);
    const chave = r.chaveAcesso || 'sem-chave';
    // DANFE só sai do XML completo (nfeProc com itens + protocolo). O resumo da
    // DistDFe (resNFe) NÃO gera DANFE — vai no ZIP marcado como -RESUMO pra não confundir.
    const completoXml = descomprimir(r.xmlCompleto);
    const ehCompleto = !!completoXml &&
      (completoXml.includes('nfeProc') || completoXml.includes('<NFe') || completoXml.includes('<infNFe'));
    if (ehCompleto) {
      out.push({ tipo: 'entrada', competencia: ref, nome: `${chave}.xml`, xml: completoXml, completo: true });
    } else {
      const resumo = descomprimir(r.xmlResumo);
      if (resumo) out.push({ tipo: 'entrada', competencia: ref, nome: `${chave}-RESUMO.xml`, xml: resumo, completo: false });
    }
  }
  return out;
}

function coletarNFSe(db, inicio, fim) {
  const rows = db.prepare(`
    SELECT id, chaveAcesso, nNFSe, nDPS, dataCompetencia, dataCriacao, xmlEnvio, xmlRetorno, status
    FROM nfse
    WHERE (xmlEnvio IS NOT NULL OR xmlRetorno IS NOT NULL)
      AND (dataCompetencia BETWEEN ? AND ? OR substr(dataCriacao,1,10) BETWEEN ? AND ?)
    ORDER BY dataCriacao ASC
  `).all(inicio.slice(0,7), fim.slice(0,7), inicio, fim);
  const out = [];
  for (const r of rows) {
    const comp = r.dataCompetencia || (r.dataCriacao || '').slice(0, 7);
    const base = r.chaveAcesso || r.nNFSe || `DPS-${r.nDPS || r.id}`;
    // Só a NFS-e autorizada (-nfse.xml) vai no ZIP. O DPS (-envio.xml) é o pedido
    // e já fica embutido dentro da NFS-e autorizada — não é mais exportado.
    if (r.xmlRetorno) {
      const raw = descomprimir(r.xmlRetorno);
      const nfse = extrairNfseAutorizada(raw);
      if (nfse) {
        // NFSe autorizada (gera o DANFSE)
        out.push({ tipo: 'nfse', competencia: comp, nome: `${base}-nfse.xml`, xml: nfse });
      } else if (raw) {
        // Retorno não-padrão (sem nfseXmlGZipB64) — preserva o que veio, mas não gera DANFSE
        out.push({ tipo: 'nfse', competencia: comp, nome: `${base}-retorno.xml`, xml: raw, completo: false });
      }
    }
  }
  return out;
}

// Nome amigável do ZIP: inclui o tipo (evita colisão entre downloads do mesmo
// período) e um período legível — "Ano-2026" pra ano inteiro, "2026-05" pra mês
// fechado, ou o intervalo cru pra recortes arbitrários.
function nomeArquivoExport(tipo, dataInicio, dataFim) {
  const TIPOS = { todos: 'Completo', saida: 'NFe-Saida', entrada: 'NFe-Entrada', nfse: 'NFSe' };
  const tLabel = TIPOS[tipo] || 'Completo';
  const [ano, mes] = dataInicio.split('-');
  let periodo;
  if (dataInicio === `${ano}-01-01` && dataFim === `${ano}-12-31`) {
    periodo = `Ano-${ano}`;
  } else {
    const ultimoDia = String(new Date(Date.UTC(Number(ano), Number(mes), 0)).getUTCDate()).padStart(2, '0');
    periodo = (dataInicio === `${ano}-${mes}-01` && dataFim === `${ano}-${mes}-${ultimoDia}`)
      ? `${ano}-${mes}`
      : `${dataInicio}_a_${dataFim}`;
  }
  return `XMLs-Fiscais_${tLabel}_${periodo}.zip`;
}

function registrarRotas(app, db) {
  app.get('/api/fiscal/xmls/sumario', (req, res) => {
    try {
      const ano = Number(req.query.ano) || new Date().getUTCFullYear();
      res.json({ success: true, ...sumarioAno(db, ano) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/fiscal/xmls/export', (req, res) => {
    try {
      if (!AdmZip) return res.status(500).json({ success: false, error: 'Biblioteca adm-zip não disponível' });

      const dataInicio = (req.query.dataInicio || '').slice(0, 10);
      const dataFim = (req.query.dataFim || '').slice(0, 10);
      if (!dataInicio || !dataFim) return res.status(400).json({ success: false, error: 'dataInicio e dataFim obrigatórios (YYYY-MM-DD)' });
      if (dataFim < dataInicio) return res.status(400).json({ success: false, error: 'dataFim deve ser >= dataInicio' });

      const tipo = (req.query.tipo || 'todos').toLowerCase();

      const documentos = [];
      if (tipo === 'todos' || tipo === 'saida') documentos.push(...coletarSaida(db, dataInicio, dataFim));
      if (tipo === 'todos' || tipo === 'entrada') documentos.push(...coletarEntrada(db, dataInicio, dataFim));
      if (tipo === 'todos' || tipo === 'nfse') documentos.push(...coletarNFSe(db, dataInicio, dataFim));

      if (!documentos.length) {
        return res.status(404).json({ success: false, error: 'Nenhum documento encontrado no período' });
      }

      const zip = new AdmZip();
      const contagem = { saida: 0, entrada: 0, nfse: 0 };
      let entradaIncompleta = 0;
      const manifesto = ['tipo;competencia;arquivo;completo'];
      for (const d of documentos) {
        const pasta = `${d.competencia || 'sem-data'}/${d.tipo}`;
        zip.addFile(`${pasta}/${d.nome}`, Buffer.from(d.xml, 'utf-8'));
        contagem[d.tipo]++;
        const completo = d.completo === false ? 'nao' : 'sim';
        if (d.tipo === 'entrada' && d.completo === false) entradaIncompleta++;
        manifesto.push(`${d.tipo};${d.competencia};${d.nome};${completo}`);
      }
      zip.addFile('MANIFESTO.csv', Buffer.from('\uFEFF' + manifesto.join('\n'), 'utf-8'));
      zip.addFile('LEIAME.txt', Buffer.from(
        `Export de XMLs fiscais — Licite Agora\n` +
        `Período: ${dataInicio} a ${dataFim}\n` +
        `Total de documentos: ${documentos.length}\n` +
        `  - NF-e saída (mod 55): ${contagem.saida}\n` +
        `  - NF-e entrada (mod 55): ${contagem.entrada}` +
          (entradaIncompleta ? ` (${entradaIncompleta} apenas RESUMO — NÃO gera DANFE)` : ``) + `\n` +
        `  - NFSe: ${contagem.nfse}\n\n` +
        `Organização: YYYY-MM/{saida|entrada|nfse}/<chave>.xml\n\n` +
        `Observações:\n` +
        `- NFSe: arquivos *-nfse.xml são a NFSe autorizada (geram o DANFSE; a DPS já vem embutida).\n` +
        `- NF-e entrada *-RESUMO.xml: é o resumo da DistDFe (resNFe) e NÃO gera DANFE. Para\n` +
        `  obter o XML completo (com DANFE), faça a manifestação/ciência + download na DistDFe.\n\n` +
        `LC 123/06 exige guarda destes documentos por 5 anos.\n`,
        'utf-8'
      ));

      const buf = zip.toBuffer();
      const nomeArq = nomeArquivoExport(tipo, dataInicio, dataFim);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArq}"`);
      res.send(buf);
    } catch (err) {
      console.error('[fiscal-arquivamento] erro:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[fiscal-arquivamento] Rotas registradas');
}

module.exports = { registrarRotasFiscalArquivamento: registrarRotas };
