/**
 * Modelo de IA por tenant — `config.<provider>_modelo`.
 *
 * ── Por que esta suíte existe ──────────────────────────────────────────────
 *
 * O ID do modelo era cravado no código, e isso quebrou quatro vezes em quatro
 * meses (qwen-3-235b, zai-glm-4.7, llama-3.3-70b, gemini-2.5-flash). Cada vez
 * o tenant ficava parado até alguém editar arquivo e reiniciar produção. Agora
 * o ID vem da tabela `config` do tenant, e o que esta suíte prende é o que
 * falharia em silêncio:
 *
 *  1. **O escolhido chega à chamada.** Gravar na config e a requisição sair com
 *     o padrão é o defeito que ninguém vê: a tela mostra o modelo novo, o
 *     provider recebe o velho, e o 404 continua. Aqui a chamada é interceptada
 *     e o ID que viajou é lido do corpo e da URL de verdade.
 *  2. **Um tenant não escolhe pelo outro.** São dois bancos, e a troca no
 *     primeiro não pode mudar o segundo.
 *  3. **O padrão continua valendo.** Tenant que nunca abriu a tela precisa
 *     seguir funcionando.
 *  4. **Lixo não vira URL.** O ID entra no caminho da URL do Gemini. Um valor
 *     com '..' apontaria a chamada para outro endpoint, então ele é recusado na
 *     gravação e ignorado na leitura.
 *
 * Banco descartável com o schema do tenant, extraído na hora. Nenhuma chamada
 * sai para a rede: o `fetch` e o SDK do Google são substituídos por captura.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const iaModelos = require('../ia-modelos');
const { createConfigHelpers } = require('../config-helpers');
const analiseIa = require('../analise-ia');
const { registrarRotasAnaliseIa } = require('../analise-ia-routes');

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const ta = async (nome, fn) => { try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

const SCHEMA = require('./schema-de-tenant').lerSchema('/tmp/vp-ia-modelo-schema.sql');
function bancoNovo(arquivo) {
  try { fs.unlinkSync(arquivo); } catch {}
  const db = new Database(arquivo);
  db.exec(SCHEMA);
  return db;
}
const dbA = bancoNovo('/tmp/vp-ia-modelo-a.db');
const dbB = bancoNovo('/tmp/vp-ia-modelo-b.db');
const setA = createConfigHelpers(dbA).setConfigValue;
const setB = createConfigHelpers(dbB).setConfigValue;

// ==================== 1. resolução ====================

t('sem escolha, vale o padrão do código', () => {
  assert(iaModelos.resolverModelo(dbA, 'gemini') === iaModelos.PADRAO.gemini,
    'config vazia devia cair no padrão');
});

t('os cinco providers têm padrão', () => {
  for (const p of iaModelos.PROVIDERS) {
    assert(typeof iaModelos.PADRAO[p] === 'string' && iaModelos.PADRAO[p].length > 0,
      `provider ${p} sem padrão`);
  }
  assert(iaModelos.PROVIDERS.length === 5, 'a cadeia tem cinco providers');
});

t('a escolha do tenant vence o padrão', () => {
  setA('gemini_modelo', 'gemini-3.8-flash');
  assert(iaModelos.resolverModelo(dbA, 'gemini') === 'gemini-3.8-flash',
    'o modelo gravado devia ter vencido');
});

t('um tenant não escolhe pelo outro', () => {
  setB('gemini_modelo', 'gemini-3.5-flash');
  assert(iaModelos.resolverModelo(dbA, 'gemini') === 'gemini-3.8-flash', 'o tenant A mudou sozinho');
  assert(iaModelos.resolverModelo(dbB, 'gemini') === 'gemini-3.5-flash', 'o tenant B não leu a própria escolha');
});

t('valor vazio volta ao padrão', () => {
  setB('groq_modelo', '');
  assert(iaModelos.resolverModelo(dbB, 'groq') === iaModelos.PADRAO.groq, 'vazio devia significar padrão');
});

t('ID com travessia de caminho é ignorado na leitura', () => {
  setB('deepseek_modelo', '../../v1/qualquer');
  assert(iaModelos.resolverModelo(dbB, 'deepseek') === iaModelos.PADRAO.deepseek,
    'um ID com .. chegou a ser usado');
});

t('modeloValido recusa o que viraria outra URL', () => {
  assert(iaModelos.modeloValido('gemini-3.6-flash'), 'recusou um ID legítimo');
  assert(iaModelos.modeloValido('openai/gpt-oss-120b'), 'recusou ID com barra, que a Groq usa');
  assert(!iaModelos.modeloValido('../outro'), 'aceitou travessia de caminho');
  assert(!iaModelos.modeloValido('x:generateContent?key=vazado'), 'aceitou query string');
  assert(!iaModelos.modeloValido(''), 'aceitou vazio');
  assert(!iaModelos.modeloValido('a'.repeat(200)), 'aceitou ID absurdamente longo');
});

// ==================== 2. a rota ====================

const app = express();
const helpersA = createConfigHelpers(dbA);
registrarRotasAnaliseIa(app, dbA, {
  getConfigValue: helpersA.getConfigValue,
  setConfigValue: helpersA.setConfigValue,
  getIAKeys: helpersA.getIAKeys,
});
const achar = (rota, metodo) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === rota && x.route.methods[metodo]);
  if (!l) throw new Error(`rota nao registrada: ${metodo.toUpperCase()} ${rota}`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const hSalvar = achar('/api/config/ia-modelo', 'post');

function chamar(handler, body) {
  let out = null, st = 200;
  const res = { json: o => { out = o; return res; }, status: c => { st = c; return res; } };
  handler({ body, params: {}, query: {}, session: {}, user: { username: 'teste' } }, res);
  return { st, out };
}

t('a rota grava a escolha', () => {
  const r = chamar(hSalvar, { provider: 'cerebras', modelo: 'gpt-oss-20b' });
  assert(r.out && r.out.success, 'a rota recusou um ID legítimo');
  assert(iaModelos.resolverModelo(dbA, 'cerebras') === 'gpt-oss-20b', 'a escolha não foi gravada');
});

t('a rota recusa ID que viraria outra URL, e não grava', () => {
  const antes = iaModelos.resolverModelo(dbA, 'cerebras');
  const r = chamar(hSalvar, { provider: 'cerebras', modelo: '../../v1/models' });
  assert(r.st === 400, `esperava 400 e veio ${r.st}`);
  assert(iaModelos.resolverModelo(dbA, 'cerebras') === antes, 'gravou mesmo recusando');
});

t('a rota recusa provider desconhecido', () => {
  const r = chamar(hSalvar, { provider: 'openai', modelo: 'gpt-4' });
  assert(r.st === 400, `esperava 400 e veio ${r.st}`);
});

t('salvar vazio devolve o provider ao padrão', () => {
  chamar(hSalvar, { provider: 'cerebras', modelo: '' });
  assert(iaModelos.resolverModelo(dbA, 'cerebras') === iaModelos.PADRAO.cerebras,
    'o vazio não devolveu ao padrão');
});

// ==================== 3. a tela ====================

const HTML = fs.readFileSync(path.join(RAIZ, 'public/configuracoes/ia.html'), 'utf8');

t('a tela tem um campo de modelo para cada provider', () => {
  for (const p of ['cerebras', 'gemini', 'deepseek', 'groq', 'anthropic']) {
    assert(HTML.includes(`id="${p}Modelo"`), `falta o campo de modelo do ${p}`);
  }
});

t('a tela conversa com as duas rotas de modelo', () => {
  assert(HTML.includes("'/api/config/ia-modelo'"), 'a tela não chama a rota de salvar modelo');
  assert(HTML.includes("'/api/config/ia-modelos'"), 'a tela não carrega o catálogo de modelos');
});

// ==================== 4. nenhum ID cravado ====================

t('nenhum ID de modelo sobrou cravado no código', () => {
  for (const arq of ['analise-ia.js', 'chat-ia.js']) {
    const src = fs.readFileSync(path.join(RAIZ, arq), 'utf8');
    // Fora do ia-modelos.js, um ID literal significa que aquele caminho ignora
    // a escolha do tenant. É exatamente o defeito que esta suíte existe para
    // não deixar voltar.
    const linhas = src.split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /(^\s*model:|getGenerativeModel\(\{ model:|v1beta\/models\/)/.test(l))
      .filter(([, l]) => !l.includes('modelo ||'));
    assert(linhas.length === 0,
      `${arq} ainda escolhe modelo sozinho na(s) linha(s) ${linhas.map(([n]) => n).join(', ')}`);
  }
});

// ==================== 5. o ID chega à chamada ====================
//
// A prova que importa: não basta resolver certo, o valor tem de viajar até a
// requisição.

const fetchOriginal = global.fetch;
function capturarFetch() {
  const visto = [];
  global.fetch = async (url, opts) => {
    visto.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }),
    };
  };
  return visto;
}

function capturarSdkGemini() {
  const pedidos = [];
  require.cache[require.resolve('@google/generative-ai')] = {
    id: require.resolve('@google/generative-ai'),
    filename: require.resolve('@google/generative-ai'),
    loaded: true,
    exports: {
      GoogleGenerativeAI: class {
        getGenerativeModel({ model }) {
          pedidos.push(model);
          return { generateContent: async () => ({ response: { text: () => '{"ok":true}' } }) };
        }
      },
    },
  };
  return pedidos;
}

(async () => {
  await ta('o modelo do tenant viaja no corpo da chamada (Groq)', async () => {
    setA('groq_modelo', 'qwen/qwen3.8-27b');
    const visto = capturarFetch();
    try { await analiseIa.testarProviders({ groq: 'gsk_teste' }, dbA); }
    finally { global.fetch = fetchOriginal; }
    const chamada = visto.find(v => v.url.includes('groq.com'));
    assert(chamada, 'a Groq não chegou a ser chamada');
    assert(chamada.body.model === 'qwen/qwen3.8-27b',
      `a requisição saiu com "${chamada.body.model}" em vez do modelo do tenant`);
  });

  await ta('sem escolha, a chamada sai com o padrão (Groq)', async () => {
    const visto = capturarFetch();
    try { await analiseIa.testarProviders({ groq: 'gsk_teste' }, dbB); }
    finally { global.fetch = fetchOriginal; }
    const chamada = visto.find(v => v.url.includes('groq.com'));
    assert(chamada, 'a Groq não chegou a ser chamada');
    assert(chamada.body.model === iaModelos.PADRAO.groq,
      `a requisição saiu com "${chamada.body.model}" em vez do padrão`);
  });

  await ta('o modelo do tenant chega ao SDK do Gemini', async () => {
    setA('gemini_modelo', 'gemini-3.8-flash');
    const pedidos = capturarSdkGemini();
    await analiseIa.testarProviders({ gemini: 'AQ.teste' }, dbA);
    assert(pedidos.length > 0, 'o SDK do Gemini não chegou a ser usado');
    assert(pedidos[0] === 'gemini-3.8-flash',
      `o SDK recebeu "${pedidos[0]}" em vez do modelo do tenant`);
  });

  await ta('o chat usa o mesmo modelo escolhido', async () => {
    const chatIa = require('../chat-ia');
    const visto = [];
    const axios = require('axios');
    const postOriginal = axios.post;
    axios.post = async (url, body) => {
      visto.push({ url: String(url), body });
      return { data: { choices: [{ message: { content: 'oi' } }] } };
    };
    try {
      await chatIa.chamarChatLLM([{ role: 'user', content: 'oi' }],
        { groq: 'gsk_teste' }, iaModelos.resolverModelos(dbA));
    } finally { axios.post = postOriginal; }
    const chamada = visto.find(v => v.url.includes('groq.com'));
    assert(chamada, 'o chat não chamou a Groq');
    assert(chamada.body.model === 'qwen/qwen3.8-27b',
      `o chat saiu com "${chamada.body.model}" em vez do modelo do tenant`);
  });

  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
