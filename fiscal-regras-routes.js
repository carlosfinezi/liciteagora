/**
 * fiscal-regras-routes.js — CRUD da matriz de regras tributárias.
 *
 * A matriz (`fiscal_regras_trib`) é o que faz a tributação ser resolvida por
 * contexto em vez de digitada nota a nota. Até a Fase 1 ela só podia ser populada
 * por SQL; este módulo é a porta de entrada para gente.
 *
 * A rota mais importante daqui não é o CRUD, é a `/simular`: dado um contexto,
 * ela responde qual regra vence, POR QUE vence (o ranking de candidatas com a
 * especificidade de cada uma) e que imposto sai. Sem isso, uma matriz com dezenas
 * de linhas vira caixa-preta na primeira vez que duas regras se sobrepõem.
 *
 * O matching não é reimplementado aqui: vem de `resolverRegraDetalhado`, a mesma
 * função que a emissão usa. Uma segunda cópia divergiria no primeiro ajuste.
 */

const {
  resolverRegraDetalhado, calcularItem, crtDoEmitente, ambitoDe, CAMPOS_CONTEXTO,
} = require('./fiscal-tributacao');

// CSTs de ICMS aceitos no regime normal (Anexo do layout NF-e).
const CST_ICMS = ['00','10','20','30','40','41','50','51','60','70','90'];
const CSOSN = ['101','102','103','201','202','203','300','400','500','900'];
const CST_IPI = ['00','01','02','03','04','05','49','50','51','52','53','54','55','99'];
const AMBITOS = ['interna','interestadual','exterior'];
const CONTRIBUINTES = ['contribuinte','isento','nao_contribuinte'];

const CAMPOS_GRAVAVEIS = [
  'descricao','prioridade','ativo',
  ...CAMPOS_CONTEXTO,
  'cstIcms','csosnIcms','modBC','pIcms','pRedBC','pFCP','pDif','motDesIcms',
  'modBCST','pMVAST','pRedBCST','pIcmsST','pFCPST',
  'cstIpi','pIpi','cstPis','pPis','cstCofins','pCofins',
  'observacaoFiscal',
  // Camada 3: vigência, benefício fiscal e FCP do destino (DIFAL)
  'vigenciaInicio','vigenciaFim','codBenef','pFcpUFDest',
];

const CAMPOS_TEXTO = new Set(['descricao','cfop','ncmPrefixo','ufOrigem','ufDestino','ambito',
  'tipoContribuinte','cstIcms','csosnIcms','cstIpi','cstPis','cstCofins','observacaoFiscal',
  'vigenciaInicio','vigenciaFim','codBenef']);

function limpar(body) {
  const linha = {};
  for (const c of CAMPOS_GRAVAVEIS) {
    let v = body[c];
    if (v === undefined || v === null || v === '') { linha[c] = null; continue; }
    if (CAMPOS_TEXTO.has(c)) {
      v = String(v).trim();
      if (['ufOrigem','ufDestino'].includes(c)) v = v.toUpperCase();
      if (c === 'ncmPrefixo' || c === 'cfop') v = v.replace(/\D/g, '');
      linha[c] = v === '' ? null : v;
    } else {
      const n = Number(v);
      linha[c] = Number.isFinite(n) ? n : null;
    }
  }
  if (linha.prioridade === null) linha.prioridade = 10;
  if (linha.ativo === null) linha.ativo = 1;
  return linha;
}

function validar(linha) {
  const erros = [];
  if (!linha.descricao) erros.push('Descrição é obrigatória');

  if (linha.cstIcms && !CST_ICMS.includes(linha.cstIcms)) erros.push(`CST de ICMS inválido: ${linha.cstIcms}`);
  if (linha.csosnIcms && !CSOSN.includes(linha.csosnIcms)) erros.push(`CSOSN inválido: ${linha.csosnIcms}`);
  if (linha.cstIpi && !CST_IPI.includes(linha.cstIpi)) erros.push(`CST de IPI inválido: ${linha.cstIpi}`);
  if (linha.ambito && !AMBITOS.includes(linha.ambito)) erros.push(`Âmbito inválido: ${linha.ambito}`);
  if (linha.tipoContribuinte && !CONTRIBUINTES.includes(linha.tipoContribuinte)) {
    erros.push(`Tipo de contribuinte inválido: ${linha.tipoContribuinte}`);
  }
  if (linha.cfop && !/^\d{4}$/.test(linha.cfop)) erros.push('CFOP deve ter 4 dígitos');
  if (linha.ncmPrefixo && !/^\d{2,8}$/.test(linha.ncmPrefixo)) erros.push('Prefixo de NCM deve ter de 2 a 8 dígitos');
  for (const uf of ['ufOrigem','ufDestino']) {
    if (linha[uf] && !/^([A-Z]{2}|EX)$/.test(linha[uf])) erros.push(`${uf} inválida`);
  }
  if (linha.regimeEmitente !== null && ![1,2,3,4].includes(linha.regimeEmitente)) {
    erros.push('Regime deve ser 1 (SN), 2 (SN excesso), 3 (Normal) ou 4 (MEI)');
  }
  for (const p of ['pIcms','pRedBC','pFCP','pDif','pMVAST','pRedBCST','pIcmsST','pFCPST','pIpi','pPis','pCofins']) {
    if (linha[p] !== null && (linha[p] < 0 || linha[p] > 100)) erros.push(`${p} deve estar entre 0 e 100`);
  }

  // Coerência com o motor: no regime normal ele exige CST de ICMS. Uma regra
  // marcada para regime 3 sem CST nunca serviria — e o erro só apareceria na
  // emissão, que é tarde demais.
  if (linha.regimeEmitente === 3 && !linha.cstIcms) {
    erros.push('Regra de regime normal precisa do CST de ICMS');
  }
  if (linha.cstIcms && linha.csosnIcms) {
    erros.push('Preencha CST (regime normal) ou CSOSN (Simples), não os dois');
  }
  // ST sem alíquota não gera grupo nenhum — silencioso e confuso.
  if (linha.pMVAST !== null && linha.pIcmsST === null) {
    erros.push('MVA informado sem alíquota de ST — o grupo de ST não seria gerado');
  }
  // Vigência
  for (const c of ['vigenciaInicio', 'vigenciaFim']) {
    if (linha[c] && !/^\d{4}-\d{2}-\d{2}$/.test(linha[c])) erros.push(`${c} deve estar no formato AAAA-MM-DD`);
  }
  if (linha.vigenciaInicio && linha.vigenciaFim && linha.vigenciaFim < linha.vigenciaInicio) {
    erros.push('Fim da vigência é anterior ao início');
  }
  // cBenef: a tabela da SEFAZ usa 8 ou 10 caracteres alfanuméricos.
  if (linha.codBenef && !/^[A-Za-z0-9]{8,10}$/.test(linha.codBenef)) {
    erros.push('Código de benefício fiscal deve ter de 8 a 10 caracteres alfanuméricos');
  }
  return erros;
}

function registrarRotas(app, db) {
  // ─── Listar ───────────────────────────────────────────────────────────────
  app.get('/api/fiscal-regras', (req, res) => {
    try {
      const filtros = [];
      const params = [];
      if (req.query.ativo === '0' || req.query.ativo === '1') { filtros.push('r.ativo = ?'); params.push(Number(req.query.ativo)); }
      if (req.query.regime) { filtros.push('r.regimeEmitente = ?'); params.push(Number(req.query.regime)); }
      if (req.query.q) {
        filtros.push('(LOWER(r.descricao) LIKE ? OR r.ncmPrefixo LIKE ? OR r.cfop LIKE ?)');
        const like = `%${String(req.query.q).toLowerCase()}%`;
        params.push(like, like, like);
      }
      const where = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';
      const regras = db.prepare(`
        SELECT r.*, t.codigo AS tipoOperacaoCodigo, p.descricao AS produtoDescricao
          FROM fiscal_regras_trib r
          LEFT JOIN tipos_operacao t ON t.id = r.tipoOperacaoId
          LEFT JOIN produtos p ON p.id = r.produtoId
          ${where}
         ORDER BY r.ativo DESC, r.prioridade DESC, r.id DESC`).all(...params);
      res.json({ success: true, regras, opcoes: { CST_ICMS, CSOSN, CST_IPI, AMBITOS, CONTRIBUINTES } });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ATENÇÃO À ORDEM: estas rotas vêm ANTES de '/:id'. O Express casa na ordem de
  // registro, e '/:id' capturaria 'aliquotas-uf' como se fosse um id.
  // ─── Alíquotas internas por UF (DIFAL) ────────────────────────────────────
  // A partilha da EC 87/2015 usa a alíquota INTERNA da UF de destino — dado da
  // outra UF, que o emitente não tem como deduzir. Nasce vazia de propósito:
  // sem o valor, o DIFAL não é calculado e a emissão diz qual UF falta.
  app.get('/api/fiscal-regras/aliquotas-uf', (req, res) => {
    try {
      const linhas = db.prepare('SELECT * FROM fiscal_aliquotas_uf ORDER BY uf').all();
      const preenchidas = linhas.filter(l => l.aliquotaInterna != null).length;
      res.json({ success: true, aliquotas: linhas, preenchidas, total: linhas.length });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.put('/api/fiscal-regras/aliquotas-uf/:uf', (req, res) => {
    try {
      const uf = String(req.params.uf || '').toUpperCase();
      if (!/^[A-Z]{2}$/.test(uf)) return res.status(400).json({ success: false, error: 'UF inválida' });
      const b = req.body || {};
      const parse = (v) => (v === null || v === undefined || v === '') ? null : Number(v);
      const aliq = parse(b.aliquotaInterna);
      const fcp = parse(b.pFcp);
      for (const [v, nome] of [[aliq, 'Alíquota interna'], [fcp, 'FCP']]) {
        if (v !== null && (!Number.isFinite(v) || v < 0 || v > 100)) {
          return res.status(400).json({ success: false, error: `${nome} deve estar entre 0 e 100` });
        }
      }
      const r = db.prepare(`UPDATE fiscal_aliquotas_uf
        SET aliquotaInterna = ?, pFcp = ?, observacao = ?, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE uf = ?`).run(aliq, fcp, b.observacao || null, uf);
      if (!r.changes) return res.status(404).json({ success: false, error: 'UF não encontrada' });
      res.json({ success: true, aliquota: db.prepare('SELECT * FROM fiscal_aliquotas_uf WHERE uf = ?').get(uf) });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/fiscal-regras/:id', (req, res) => {
    const regra = db.prepare('SELECT * FROM fiscal_regras_trib WHERE id = ?').get(Number(req.params.id));
    if (!regra) return res.status(404).json({ success: false, error: 'Regra não encontrada' });
    res.json({ success: true, regra });
  });

  // ─── Criar ────────────────────────────────────────────────────────────────
  app.post('/api/fiscal-regras', (req, res) => {
    try {
      const linha = limpar(req.body || {});
      const erros = validar(linha);
      if (erros.length) return res.status(400).json({ success: false, error: erros.join(' · '), erros });

      const cols = CAMPOS_GRAVAVEIS;
      const r = db.prepare(`INSERT INTO fiscal_regras_trib (${cols.join(', ')})
        VALUES (${cols.map(c => '@' + c).join(', ')})`).run(linha);
      res.json({ success: true, id: r.lastInsertRowid,
        regra: db.prepare('SELECT * FROM fiscal_regras_trib WHERE id = ?').get(r.lastInsertRowid) });
    } catch (error) {
      console.error('[fiscal-regras] criar:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ─── Editar ───────────────────────────────────────────────────────────────
  app.put('/api/fiscal-regras/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!db.prepare('SELECT id FROM fiscal_regras_trib WHERE id = ?').get(id)) {
        return res.status(404).json({ success: false, error: 'Regra não encontrada' });
      }
      const linha = limpar(req.body || {});
      const erros = validar(linha);
      if (erros.length) return res.status(400).json({ success: false, error: erros.join(' · '), erros });

      db.prepare(`UPDATE fiscal_regras_trib SET
          ${CAMPOS_GRAVAVEIS.map(c => `${c} = @${c}`).join(', ')},
          dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = @id`).run({ ...linha, id });
      res.json({ success: true, regra: db.prepare('SELECT * FROM fiscal_regras_trib WHERE id = ?').get(id) });
    } catch (error) {
      console.error('[fiscal-regras] editar:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ─── Duplicar ─────────────────────────────────────────────────────────────
  // Regra fiscal quase nunca nasce sozinha: a variação por UF ou por âmbito é o
  // caso comum. Duplicar e ajustar um campo é o fluxo real de quem cadastra.
  app.post('/api/fiscal-regras/:id/duplicar', (req, res) => {
    try {
      const orig = db.prepare('SELECT * FROM fiscal_regras_trib WHERE id = ?').get(Number(req.params.id));
      if (!orig) return res.status(404).json({ success: false, error: 'Regra não encontrada' });
      const linha = limpar({ ...orig, descricao: `${orig.descricao} (cópia)` });
      const r = db.prepare(`INSERT INTO fiscal_regras_trib (${CAMPOS_GRAVAVEIS.join(', ')})
        VALUES (${CAMPOS_GRAVAVEIS.map(c => '@' + c).join(', ')})`).run(linha);
      res.json({ success: true, id: r.lastInsertRowid,
        regra: db.prepare('SELECT * FROM fiscal_regras_trib WHERE id = ?').get(r.lastInsertRowid) });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ─── Excluir ──────────────────────────────────────────────────────────────
  // Regra que já decidiu imposto de nota emitida NÃO é apagada: a memória de
  // cálculo aponta para ela, e apagar quebraria a explicação de uma nota que já
  // está na SEFAZ. Nesse caso, desativa.
  app.post('/api/fiscal-regras/:id/excluir', (req, res) => {
    try {
      const id = Number(req.params.id);
      const regra = db.prepare('SELECT id FROM fiscal_regras_trib WHERE id = ?').get(id);
      if (!regra) return res.status(404).json({ success: false, error: 'Regra não encontrada' });

      const usos = db.prepare('SELECT COUNT(*) c FROM fiscal_calculo_memoria WHERE regraId = ?').get(id).c;
      if (usos > 0) {
        db.prepare('UPDATE fiscal_regras_trib SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(id);
        return res.json({ success: true, desativada: true, usos,
          aviso: `Regra usada em ${usos} cálculo(s) de nota já emitida — foi desativada, não apagada.` });
      }
      db.prepare('DELETE FROM fiscal_regras_trib WHERE id = ?').run(id);
      res.json({ success: true, desativada: false });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ─── Simular ──────────────────────────────────────────────────────────────
  // O coração da tela: qual regra vence neste contexto, por que, e que imposto sai.
  app.post('/api/fiscal-regras/simular', (req, res) => {
    try {
      const b = req.body || {};
      const emit = db.prepare('SELECT uf FROM fornecedor WHERE id = 1').get() || {};
      const crt = b.crt ? Number(b.crt) : crtDoEmitente(db);
      const ufOrigem = (b.ufOrigem || emit.uf || '').toUpperCase() || null;
      const ufDestino = (b.ufDestino || '').toUpperCase() || null;

      const ctx = {
        crt,
        tipoOperacaoId: b.tipoOperacaoId ? Number(b.tipoOperacaoId) : null,
        cfop: b.cfop || null,
        ncm: b.ncm || null,
        produtoId: b.produtoId ? Number(b.produtoId) : null,
        ufOrigem, ufDestino,
        ambito: ambitoDe(ufOrigem, ufDestino),
        tipoContribuinte: b.tipoContribuinte || null,
        // Não contribuinte é, por definição, consumidor final — e o DIFAL depende
        // dos dois sinais. Derivar aqui evita que a tela e a emissão precisem
        // lembrar de mandar o par completo (a emissão faz a mesma derivação).
        consumidorFinal: (b.consumidorFinal === undefined || b.consumidorFinal === null || b.consumidorFinal === '')
          ? (b.tipoContribuinte === 'nao_contribuinte' ? 1 : null)
          : Number(b.consumidorFinal),
        dataReferencia: b.dataReferencia || null,
        origemProduto: b.origemProduto || '0',
        vProd: Number(b.vProd) || 0,
        vFrete: Number(b.vFrete) || 0,
        vDesc: Number(b.vDesc) || 0,
        vOutro: 0,
        csosnFallback: b.csosnFallback || '400',
      };

      const det = resolverRegraDetalhado(db, ctx);
      const resposta = {
        success: true, crt, ambito: ctx.ambito, dataReferencia: ctx.dataReferencia,
        vencedora: det.vencedora ? { id: det.vencedora.id, descricao: det.vencedora.descricao } : null,
        candidatas: det.candidatas.map(c => ({
          id: c.regra.id, descricao: c.regra.descricao,
          especificidade: c.especificidade, prioridade: c.regra.prioridade,
          contexto: CAMPOS_CONTEXTO
            .filter(k => c.regra[k] !== null && c.regra[k] !== undefined)
            .map(k => `${k}=${c.regra[k]}`),
          vencedora: det.vencedora && c.regra.id === det.vencedora.id,
        })),
      };

      try {
        const r = calcularItem(db, ctx);
        resposta.calculo = {
          ok: true, grupo: r.grupo, icms: r.icms, ipi: r.ipi, pis: r.pis, cofins: r.cofins,
          totais: r.totais, memoria: r.memoria, origem: r.origem,
          icmsUFDest: r.icmsUFDest || null, difalErro: r.difalErro || null,
          codBenef: r.codBenef || null,
        };
      } catch (err) {
        resposta.calculo = { ok: false, erro: err.message };
      }

      res.json(resposta);
    } catch (error) {
      console.error('[fiscal-regras] simular:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[fiscal-regras] Rotas registradas');
}

module.exports = { registrarRotasFiscalRegras: registrarRotas, CST_ICMS, CSOSN, CST_IPI };
