#!/usr/bin/env node
/**
 * test-fiscal-regras.js — CRUD + simulador da matriz de regras tributárias.
 *
 * Roda contra o tenant de laboratório `labfiscal`, em porta alta.
 *
 * O que mais importa aqui não é o CRUD e sim (a) as validações que impedem
 * cadastrar regra que só falharia na hora de emitir, e (b) o simulador — que
 * precisa concordar com o motor, senão a tela ensina uma coisa e a emissão faz
 * outra.
 *
 * Uso: node scripts/test-fiscal-regras.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const express = require(BASE + '/node_modules/express');
const Database = require(BASE + '/node_modules/better-sqlite3');
const { registrarRotasFiscalRegras } = require(BASE + '/fiscal-regras-routes');
const T = require(BASE + '/fiscal-tributacao');

const PORTA = 34121;
const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

// Massa própria — a bateria não garante ordem de execução.
db.prepare('DELETE FROM fiscal_regras_trib').run();
db.prepare("DELETE FROM fiscal_calculo_memoria WHERE documentoId = 9999").run();
if (!db.prepare('SELECT COUNT(*) c FROM fornecedor WHERE id = 1').get().c) {
  db.prepare("INSERT INTO fornecedor (id, razaoSocial) VALUES (1, 'Lab Fiscal')").run();
}
db.prepare("UPDATE fornecedor SET regimeTributario = 'NAO_OPTANTE', uf = 'TO' WHERE id = 1").run();

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, role: 'admin' }; next(); });
registrarRotasFiscalRegras(app, db);
const server = app.listen(PORTA);

const API = p => `http://127.0.0.1:${PORTA}${p}`;
async function req(metodo, p, body) {
  const r = await fetch(API(p), {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}
const post = (p, b) => req('POST', p, b || {});
const put = (p, b) => req('PUT', p, b);
const get = p => req('GET', p);

const REGRA_FERT = {
  descricao: 'Fertilizante NCM 3105 — ICMS c/ reducao de base',
  regimeEmitente: 3, ncmPrefixo: '3105',
  cstIcms: '20', modBC: 3, pIcms: 12, pRedBC: 78.95,
  cstPis: '01', pPis: 1.65, cstCofins: '01', pCofins: 7.6,
  observacaoFiscal: 'Conv. ICMS 100/97',
};

(async () => {
  // ─── 1. CRUD ──────────────────────────────────────────────────────────────
  secao('CRUD');
  const c = await post('/api/fiscal-regras', REGRA_FERT);
  assert(c.json.success, 'regra criada', c.json.error);
  const idFert = c.json.id;
  assert(c.json.regra.pRedBC === 78.95, `redução gravada (${c.json.regra.pRedBC})`);
  assert(c.json.regra.ativo === 1, 'nasce ativa');
  assert(c.json.regra.prioridade === 10, 'prioridade padrão 10');

  const g = await get('/api/fiscal-regras/' + idFert);
  assert(g.json.success && g.json.regra.cstIcms === '20', 'leitura individual');

  const e = await put('/api/fiscal-regras/' + idFert, { ...REGRA_FERT, pIcms: 7 });
  assert(e.json.success && e.json.regra.pIcms === 7, `edição alterou a alíquota (${e.json.regra && e.json.regra.pIcms})`);
  await put('/api/fiscal-regras/' + idFert, REGRA_FERT);  // volta para 12

  const l = await get('/api/fiscal-regras?ativo=1');
  assert(l.json.success && l.json.regras.length === 1, `lista traz 1 regra (veio ${l.json.regras && l.json.regras.length})`);
  assert(Array.isArray(l.json.opcoes.CST_ICMS) && l.json.opcoes.CST_ICMS.includes('20'),
    'lista devolve as opções de CST para a tela');

  const dup = await post(`/api/fiscal-regras/${idFert}/duplicar`);
  assert(dup.json.success && /cópia/.test(dup.json.regra.descricao), 'duplicar cria cópia identificável');
  assert(dup.json.regra.pRedBC === 78.95, 'cópia preserva os valores fiscais');
  await post(`/api/fiscal-regras/${dup.json.id}/excluir`);

  // ─── 2. Validações ────────────────────────────────────────────────────────
  secao('Validações');
  const casos = [
    [{ ...REGRA_FERT, descricao: '' }, /Descrição/, 'exige descrição'],
    [{ ...REGRA_FERT, cstIcms: '77' }, /CST de ICMS/, 'recusa CST de ICMS inexistente'],
    [{ ...REGRA_FERT, csosnIcms: '400' }, /não os dois/, 'recusa CST e CSOSN juntos'],
    [{ descricao: 'x', regimeEmitente: 3 }, /regime normal precisa/, 'regime normal sem CST é recusado'],
    [{ ...REGRA_FERT, cfop: '51' }, /CFOP deve ter 4/, 'recusa CFOP de tamanho errado'],
    [{ ...REGRA_FERT, ncmPrefixo: '1' }, /Prefixo de NCM/, 'recusa prefixo de NCM curto demais'],
    [{ ...REGRA_FERT, pIcms: 150 }, /entre 0 e 100/, 'recusa alíquota fora da faixa'],
    [{ ...REGRA_FERT, regimeEmitente: 9 }, /Regime deve ser/, 'recusa regime inexistente'],
    [{ ...REGRA_FERT, pMVAST: 40 }, /MVA informado sem alíquota/, 'recusa MVA sem alíquota de ST'],
    [{ ...REGRA_FERT, ambito: 'lunar' }, /Âmbito inválido/, 'recusa âmbito inexistente'],
  ];
  for (const [corpo, padrao, msg] of casos) {
    const r = await post('/api/fiscal-regras', corpo);
    assert(r.status === 400 && padrao.test(r.json.error || ''), msg, r.json.error);
  }

  // ─── 3. Normalização de entrada ───────────────────────────────────────────
  secao('Normalização');
  const norm = await post('/api/fiscal-regras', {
    descricao: '  Teste normalizacao  ', regimeEmitente: 3, cstIcms: '00', pIcms: 18,
    ufDestino: 'go', cfop: '5.102', ncmPrefixo: '2202.10',
  });
  assert(norm.json.success, 'aceita entrada "suja"', norm.json.error);
  assert(norm.json.regra.ufDestino === 'GO', `UF em maiúsculas (${norm.json.regra.ufDestino})`);
  assert(norm.json.regra.cfop === '5102', `CFOP sem pontuação (${norm.json.regra.cfop})`);
  assert(norm.json.regra.ncmPrefixo === '220210', `NCM sem pontuação (${norm.json.regra.ncmPrefixo})`);
  assert(norm.json.regra.descricao === 'Teste normalizacao', 'descrição sem espaços nas pontas');
  await post(`/api/fiscal-regras/${norm.json.id}/excluir`);

  // ─── 4. Simulador ─────────────────────────────────────────────────────────
  secao('Simulador — resolução e cálculo');
  {
    const s = await post('/api/fiscal-regras/simular', {
      crt: 3, ncm: '31051000', cfop: '5102', ufOrigem: 'TO', ufDestino: 'TO', vProd: 1,
    });
    assert(s.json.success, 'simulação respondeu', s.json.error);
    assert(s.json.ambito === 'interna', `âmbito derivado das UFs (${s.json.ambito})`);
    assert(s.json.vencedora && s.json.vencedora.id === idFert, 'apontou a regra vencedora');
    assert(s.json.candidatas.length === 1 && s.json.candidatas[0].especificidade === 2,
      `especificidade 2 (regime + NCM) — veio ${s.json.candidatas[0] && s.json.candidatas[0].especificidade}`);
    assert(s.json.calculo.ok && s.json.calculo.icms.vICMS === '0.03',
      `ICMS 0,03 — o mesmo valor do ERP de referência (veio ${s.json.calculo.icms && s.json.calculo.icms.vICMS})`);
    assert(/REDUCAOBASE/.test(s.json.calculo.memoria[0].formula), 'devolve a memória de cálculo');
  }

  secao('Simulador — a mais específica vence');
  const idEspecifica = (await post('/api/fiscal-regras', {
    descricao: 'Fertilizante 3105 para GO', regimeEmitente: 3, ncmPrefixo: '3105',
    ufDestino: 'GO', cstIcms: '00', modBC: 3, pIcms: 4,
  })).json.id;
  {
    const s = await post('/api/fiscal-regras/simular', {
      crt: 3, ncm: '31051000', ufOrigem: 'TO', ufDestino: 'GO', vProd: 100,
    });
    assert(s.json.candidatas.length === 2, `duas candidatas (veio ${s.json.candidatas.length})`);
    assert(s.json.vencedora.id === idEspecifica, 'a de UF específica vence a genérica');
    const vencedoraNaLista = s.json.candidatas.find(x => x.vencedora);
    assert(vencedoraNaLista && vencedoraNaLista.especificidade === 3,
      'a vencedora é a de maior especificidade (3)');
    assert(s.json.calculo.icms.vICMS === '4.00', `usou a alíquota da específica (${s.json.calculo.icms.vICMS})`);
    // Mesmo destino, mas para TO: volta para a genérica
    const s2 = await post('/api/fiscal-regras/simular', {
      crt: 3, ncm: '31051000', ufOrigem: 'TO', ufDestino: 'TO', vProd: 100,
    });
    assert(s2.json.vencedora.id === idFert, 'trocando a UF, a genérica volta a vencer');
  }

  secao('Simulador — desempate por prioridade');
  {
    const a = await post('/api/fiscal-regras', {
      descricao: 'Empate A', regimeEmitente: 3, ncmPrefixo: '8471', cstIcms: '00', modBC: 3, pIcms: 18, prioridade: 5,
    });
    const b = await post('/api/fiscal-regras', {
      descricao: 'Empate B', regimeEmitente: 3, ncmPrefixo: '8471', cstIcms: '00', modBC: 3, pIcms: 12, prioridade: 50,
    });
    const s = await post('/api/fiscal-regras/simular', { crt: 3, ncm: '84713012', ufDestino: 'TO', vProd: 100 });
    assert(s.json.vencedora.id === b.json.id, 'com mesma especificidade, vence a de maior prioridade');
    assert(s.json.calculo.icms.vICMS === '12.00', `alíquota da prioritária (${s.json.calculo.icms.vICMS})`);
    await post(`/api/fiscal-regras/${a.json.id}/excluir`);
    await post(`/api/fiscal-regras/${b.json.id}/excluir`);
  }

  secao('Simulador — sem regra e Simples');
  {
    const s = await post('/api/fiscal-regras/simular', { crt: 3, ncm: '99999999', ufDestino: 'SP', vProd: 100 });
    assert(s.json.candidatas.length === 0, 'nenhuma candidata');
    assert(s.json.calculo.ok === false && /Sem regra tribut/.test(s.json.calculo.erro),
      'explica que falta regra em vez de devolver imposto zerado', s.json.calculo.erro);

    const sn = await post('/api/fiscal-regras/simular', { crt: 1, ncm: '31051000', ufDestino: 'TO', vProd: 100 });
    assert(sn.json.calculo.ok && sn.json.calculo.grupo === 'ICMSSN',
      'Simples cai no grupo CSOSN mesmo com regras de regime normal cadastradas');
    assert(sn.json.candidatas.length === 0, 'regra de regime 3 não aparece como candidata para CRT 1');
  }

  // ─── 5. Simulador concorda com o motor ────────────────────────────────────
  secao('Simulador × motor: mesma resposta');
  {
    const s = await post('/api/fiscal-regras/simular', {
      crt: 3, ncm: '31051000', ufOrigem: 'TO', ufDestino: 'TO', vProd: 137.5, vFrete: 12.5,
    });
    const direto = T.calcularItem(db, {
      crt: 3, ncm: '31051000', ufOrigem: 'TO', ufDestino: 'TO',
      ambito: 'interna', vProd: 137.5, vFrete: 12.5, vDesc: 0, vOutro: 0, origemProduto: '0',
    });
    assert(s.json.calculo.icms.vBC === direto.icms.vBC && s.json.calculo.icms.vICMS === direto.icms.vICMS,
      `tela e emissão dão o mesmo número (${s.json.calculo.icms.vICMS} = ${direto.icms.vICMS})`);
  }

  // ─── 6. Exclusão protege regra já usada ───────────────────────────────────
  secao('Exclusão de regra já usada em nota emitida');
  {
    db.prepare(`INSERT INTO fiscal_calculo_memoria
      (documento, documentoId, itemId, imposto, origem, regraId, cst, base, aliquota, reducao, valor, formula)
      VALUES ('fatura', 9999, 1, 'ICMS', 'CALCULADO', ?, '20', 0.21, 12, 78.95, 0.03, 'teste')`).run(idFert);
    const r = await post(`/api/fiscal-regras/${idFert}/excluir`);
    assert(r.json.success && r.json.desativada === true, 'desativa em vez de apagar');
    assert(/1 cálculo/.test(r.json.aviso || ''), 'avisa quantas notas dependem dela', r.json.aviso);
    const ainda = db.prepare('SELECT ativo FROM fiscal_regras_trib WHERE id = ?').get(idFert);
    assert(ainda && ainda.ativo === 0, 'continua existindo, porém inativa');
    // Inativa não participa mais da resolução
    const s = await post('/api/fiscal-regras/simular', { crt: 3, ncm: '31051000', ufDestino: 'TO', vProd: 1 });
    assert(!s.json.candidatas.some(x => x.id === idFert), 'regra inativa sai da resolução');
    db.prepare('DELETE FROM fiscal_calculo_memoria WHERE documentoId = 9999').run();
  }

  // ─── 7. Camada 3: vigência, cBenef e alíquotas por UF ─────────────────────
  secao('Camada 3 — validações de vigência e benefício');
  {
    const casos = [
      [{ ...REGRA_FERT, vigenciaInicio: '01/01/2026' }, /AAAA-MM-DD/, 'recusa data em formato brasileiro'],
      [{ ...REGRA_FERT, vigenciaInicio: '2026-06-01', vigenciaFim: '2026-01-01' },
        /anterior ao início/, 'recusa fim de vigência antes do início'],
      [{ ...REGRA_FERT, codBenef: 'ABC' }, /8 a 10 caracteres/, 'recusa cBenef curto demais'],
      [{ ...REGRA_FERT, codBenef: 'TO-8000-01' }, /8 a 10 caracteres/, 'recusa cBenef com pontuação'],
    ];
    for (const [corpo, padrao, msg] of casos) {
      const r = await post('/api/fiscal-regras', corpo);
      assert(r.status === 400 && padrao.test(r.json.error || ''), msg, r.json.error);
    }
    const bom = await post('/api/fiscal-regras', { ...REGRA_FERT, descricao: 'Com vigencia',
      vigenciaInicio: '2026-01-01', vigenciaFim: '2026-12-31', codBenef: 'TO800001' });
    assert(bom.json.success, 'aceita vigência e cBenef válidos', bom.json.error);
    assert(bom.json.regra.vigenciaInicio === '2026-01-01' && bom.json.regra.codBenef === 'TO800001',
      'grava os dois campos');
    await post(`/api/fiscal-regras/${bom.json.id}/excluir`);
  }

  secao('Camada 3 — alíquotas por UF');
  {
    const l = await get('/api/fiscal-regras/aliquotas-uf');
    assert(l.json.success && l.json.total === 27, `27 UFs listadas (veio ${l.json.total})`);
    assert(l.json.preenchidas === 0, 'nascem todas vazias — nenhum número inventado');

    const up = await put('/api/fiscal-regras/aliquotas-uf/go', { aliquotaInterna: 19, pFcp: 2 });
    assert(up.json.success && up.json.aliquota.aliquotaInterna === 19, 'grava alíquota (UF em minúscula é aceita)');

    const ruim = await put('/api/fiscal-regras/aliquotas-uf/GO', { aliquotaInterna: 150 });
    assert(ruim.status === 400 && /entre 0 e 100/.test(ruim.json.error), 'recusa alíquota fora da faixa');

    const inexistente = await put('/api/fiscal-regras/aliquotas-uf/XX', { aliquotaInterna: 10 });
    assert(inexistente.status === 400 || inexistente.status === 404, 'recusa UF inexistente');

    const l2 = await get('/api/fiscal-regras/aliquotas-uf');
    assert(l2.json.preenchidas === 1, 'contador de preenchidas reflete o cadastro');

    // A rota /aliquotas-uf não pode ser capturada por /:id
    assert(Array.isArray(l2.json.aliquotas), 'rota /aliquotas-uf não colide com /:id');

    db.prepare('UPDATE fiscal_aliquotas_uf SET aliquotaInterna = NULL, pFcp = NULL').run();
  }

  secao('Camada 3 — simulador com data e DIFAL');
  {
    db.prepare('DELETE FROM fiscal_regras_trib').run();
    await post('/api/fiscal-regras', { descricao: 'Interestadual 7%', regimeEmitente: 3,
      cstIcms: '00', modBC: 3, pIcms: 7 });
    await put('/api/fiscal-regras/aliquotas-uf/GO', { aliquotaInterna: 19 });

    const s = await post('/api/fiscal-regras/simular', {
      crt: 3, ncm: '84713012', ufOrigem: 'TO', ufDestino: 'GO',
      tipoContribuinte: 'nao_contribuinte', vProd: 1000, dataReferencia: '2026-08-25',
    });
    assert(s.json.calculo.ok, 'simulação com DIFAL respondeu', s.json.calculo.erro);
    assert(s.json.calculo.icmsUFDest && s.json.calculo.icmsUFDest.vICMSUFDest === '120.00',
      `simulador mostra o DIFAL 120,00 (veio ${s.json.calculo.icmsUFDest && s.json.calculo.icmsUFDest.vICMSUFDest})`);
    assert(s.json.dataReferencia === '2026-08-25', 'devolve a data usada na resolução');

    db.prepare('UPDATE fiscal_aliquotas_uf SET aliquotaInterna = NULL').run();
    const s2 = await post('/api/fiscal-regras/simular', {
      crt: 3, ncm: '84713012', ufOrigem: 'TO', ufDestino: 'GO',
      tipoContribuinte: 'nao_contribuinte', vProd: 1000,
    });
    assert(/GO/.test(s2.json.calculo.difalErro || ''),
      'sem alíquota cadastrada, o simulador explica em vez de mostrar zero');
  }

  // Limpeza
  db.prepare('DELETE FROM fiscal_regras_trib').run();
  db.prepare('UPDATE fiscal_aliquotas_uf SET aliquotaInterna = NULL, pFcp = NULL').run();

  server.close();
  db.close();
  console.log(`\n${'─'.repeat(56)}`);
  console.log(fail === 0 ? `TODOS OS ${ok} ASSERTS PASSARAM` : `${ok} OK · ${fail} FALHARAM`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.error('ERRO FATAL:', err);
  try { server.close(); } catch {}
  process.exit(1);
});
