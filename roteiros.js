/**
 * Roteiros de venda: qualificação com pontuação.
 *
 * ── O que é um roteiro aqui ────────────────────────────────────────────────
 *
 * Um documento com perguntas, as respostas possíveis de cada uma e o peso de
 * cada resposta. O vendedor toca na resposta que ouviu; a soma e o corte são
 * cálculo do sistema, e não julgamento de quem preencheu.
 *
 * ── Por que a pontuação NÃO é pedida à IA ──────────────────────────────────
 *
 * Mesmo no roteiro que a IA vai preencher sozinha, quem soma é o Node. Pedir a
 * nota ao modelo dá número que muda a cada execução e que ninguém consegue
 * auditar depois. O modelo classifica a resposta; o peso é tabela.
 *
 * ── As variáveis ───────────────────────────────────────────────────────────
 *
 * O texto do roteiro é lido na frente do cliente, e cada empresa tem os seus
 * dados. `{{empresaCidade}}` sai do cadastro, `{{precoEntrada}}` sai do próprio
 * roteiro. Variável desconhecida é recusada ao salvar, e não trocada por vazio:
 * o vendedor leria "atendemos desde " no meio da frase, sem perceber.
 */

/** O que sai do cadastro da empresa. O resto vem dos valores do roteiro. */
const VARIAVEIS_EMPRESA = {
  empresaNome: (f) => f.nomeFantasia || f.razaoSocial || '',
  empresaRazao: (f) => f.razaoSocial || '',
  empresaCidade: (f) => [f.cidade, f.uf].filter(Boolean).join('/'),
  empresaTelefone: (f) => f.telefone || f.celular || '',
  empresaEmail: (f) => f.email || '',
  empresaSite: (f) => f.site || '',
  empresaCnpj: (f) => f.cnpj || '',
};

/**
 * O que só existe na hora do preenchimento: quem está fazendo a visita. Não sai
 * do cadastro da empresa nem do roteiro, e por isso tem grupo próprio.
 */
const VARIAVEIS_CONTEXTO = ['vendedorNome'];

const CANAIS = ['visita', 'whatsapp'];
const STATUS = ['em_visita', 'agendado', 'pensando', 'descartado'];

/** Troca as variáveis do texto. Valor do roteiro vence o do cadastro. */
function render(texto, { empresa = {}, valores = {}, contexto = {} } = {}) {
  return String(texto || '').replace(/\{\{(\w+)\}\}/g, (m, chave) => {
    if (contexto[chave] != null && contexto[chave] !== '') return String(contexto[chave]);
    if (valores[chave] != null && valores[chave] !== '') return String(valores[chave]);
    const fn = VARIAVEIS_EMPRESA[chave];
    return fn ? fn(empresa) : m;
  });
}

/** Variáveis usadas no texto que ninguém sabe resolver. */
function variaveisDesconhecidas(config) {
  const conhecidas = new Set([...Object.keys(VARIAVEIS_EMPRESA), ...VARIAVEIS_CONTEXTO,
                              ...Object.keys(config?.valores || {})]);
  const achadas = new Set();
  const varrer = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\{\{(\w+)\}\}/g)) if (!conhecidas.has(m[1])) achadas.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(varrer);
    else if (v && typeof v === 'object') Object.values(v).forEach(varrer);
  };
  varrer(config);
  return [...achadas];
}

/**
 * Soma os pesos das respostas marcadas.
 *
 * Resposta que não existe no roteiro é ignorada, e volta em `desconhecidas`:
 * somar peso zero calado esconderia um roteiro editado por baixo de uma visita
 * já preenchida.
 */
function pontuar(config, respostas = {}) {
  const perguntas = Array.isArray(config?.perguntas) ? config.perguntas : [];
  let pontos = 0;
  const dores = [], desconhecidas = [], respondidas = [];
  for (const p of perguntas) {
    const escolhido = respostas[p.chave];
    if (escolhido == null || escolhido === '') continue;
    const op = (p.opcoes || []).find(o => o.id === escolhido);
    if (!op) { desconhecidas.push(`${p.chave}=${escolhido}`); continue; }
    pontos += Number(op.peso) || 0;
    respondidas.push({ chave: p.chave, pergunta: p.texto, resposta: op.rotulo, peso: Number(op.peso) || 0 });
    if ((Number(op.peso) || 0) > 0 && op.dor) dores.push(op.dor);
  }
  const corte = Number(config?.corte);
  const maximo = perguntas.reduce((s, p) =>
    s + Math.max(0, ...(p.opcoes || []).map(o => Number(o.peso) || 0)), 0);
  return {
    pontos, maximo, dores, desconhecidas, respondidas,
    faltam: perguntas.filter(p => respostas[p.chave] == null || respostas[p.chave] === '').map(p => p.chave),
    qualificado: pontos >= (Number.isFinite(corte) ? corte : 2),
  };
}

/**
 * Porte: o corte que decide se a visita continua.
 *
 * Existe porque o plano que atende o comércio de balcão é o mais caro da
 * tabela. Sem este filtro, o vendedor qualifica dor por cinco minutos, mostra
 * oito de vídeo e agenda meia hora do dono com quem não vai pagar.
 *
 * Basta UM critério bater. São medidas que se observam na calçada, e não
 * faturamento, que ninguém responde a um desconhecido na primeira visita.
 */
function temPorte(config, dados = {}) {
  const p = config?.porte;
  if (!p) return true;
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const caixas = n(dados.caixas), funcionarios = n(dados.funcionarios);
  if (dados.maisDeUmPonto) return true;
  if (caixas != null && p.caixasMin != null && caixas >= p.caixasMin) return true;
  if (funcionarios != null && p.funcionariosMin != null && funcionarios >= p.funcionariosMin) return true;
  // Nada informado não reprova: quem esquece de contar caixa não pode ter a
  // visita bloqueada por isso.
  if (caixas == null && funcionarios == null && !('maisDeUmPonto' in dados)) return true;
  return false;
}

/**
 * O resumo que vai para quem fecha a venda.
 *
 * É o passo que mais falha no papel: hoje o vendedor precisa digitar sete itens
 * no WhatsApp no mesmo dia. Aqui ele já existe assim que as respostas foram
 * marcadas, e enviar vira um botão.
 */
function resumo(config, visita = {}, extra = {}) {
  const r = pontuar(config, visita.respostas || {});
  const linhas = [];
  linhas.push(`*${visita.empresa || 'Empresa sem nome'}*${visita.segmento ? ` · ${visita.segmento}` : ''}`);
  if (visita.decisor || visita.whatsapp) {
    linhas.push(`Decisor: ${[visita.decisor, visita.whatsapp].filter(Boolean).join(' · ')}`);
  }
  linhas.push(`Qualificação: ${r.pontos} de ${r.maximo}${r.qualificado ? '' : ' (abaixo do corte)'}`);
  if (r.dores.length) {
    linhas.push('', 'Dores:');
    for (const d of r.dores) linhas.push(`• ${d}`);
  }
  if (visita.videoAssistido) {
    linhas.push('', `Vídeo: assistido${visita.reacaoVideo ? ` — reagiu em "${visita.reacaoVideo}"` : ''}`);
  } else {
    linhas.push('', 'Vídeo: não assistido');
  }
  if (visita.objecao) {
    const o = (config?.objecoes || []).find(x => x.chave === visita.objecao);
    linhas.push(`Objeção: ${o ? o.rotulo : visita.objecao}`);
  }
  if (visita.contador) linhas.push(`Contador: ${visita.contador}`);
  const st = { agendado: 'Agendado', pensando: 'Pensando', descartado: 'Descartado',
               em_visita: 'Visita em andamento' }[visita.status] || visita.status;
  linhas.push('', `Status: ${st}${extra.quando ? ` — ${extra.quando}` : ''}${visita.motivo ? ` (${visita.motivo})` : ''}`);
  return linhas.join('\n');
}

/** Recusa roteiro que faria a tela mentir ou o cálculo somar errado. */
function validar(config) {
  const p = [];
  const perguntas = Array.isArray(config?.perguntas) ? config.perguntas : null;
  if (!perguntas || !perguntas.length) p.push('O roteiro precisa de pelo menos uma pergunta');
  const chaves = new Set();
  for (const [i, q] of (perguntas || []).entries()) {
    const onde = `pergunta ${i + 1}`;
    if (!q.chave) p.push(`${onde}: sem chave`);
    else if (chaves.has(q.chave)) p.push(`${onde}: chave repetida (${q.chave})`);
    else chaves.add(q.chave);
    if (!q.texto) p.push(`${onde}: sem texto`);
    const ops = Array.isArray(q.opcoes) ? q.opcoes : [];
    if (ops.length < 2) p.push(`${onde}: precisa de pelo menos duas respostas`);
    const ids = new Set();
    for (const o of ops) {
      if (!o.id) p.push(`${onde}: resposta sem id`);
      else if (ids.has(o.id)) p.push(`${onde}: resposta repetida (${o.id})`);
      else ids.add(o.id);
      if (!o.rotulo) p.push(`${onde}: resposta sem rótulo`);
      const peso = Number(o.peso);
      if (!Number.isFinite(peso) || peso < 0) p.push(`${onde}: peso inválido em "${o.rotulo || o.id}"`);
    }
  }
  const corte = Number(config?.corte);
  if (!Number.isFinite(corte) || corte < 0) p.push('Corte de qualificação inválido');
  const desconhecidas = variaveisDesconhecidas(config);
  if (desconhecidas.length) {
    // Sairia um buraco no meio da frase que o vendedor lê na frente do cliente.
    p.push('Variável sem valor: ' + desconhecidas.map(v => `{{${v}}}`).join(', '));
  }
  return p;
}

/**
 * O pedido que a IA recebe para preencher o roteiro a partir da conversa.
 *
 * Só entram as perguntas ainda sem resposta: repetir o que já foi respondido
 * gasta token e convida o modelo a mudar de ideia sobre o que já estava certo.
 *
 * A exigência do TRECHO é o que segura a invenção. Sem ela o modelo preenche as
 * cinco perguntas de uma conversa de duas linhas, e a nota fica alta sem nada
 * por trás.
 */
function promptExtracao(config, historico, jaRespondidas = {}) {
  const faltam = (config.perguntas || []).filter(p => !jaRespondidas[p.chave]);
  const conversa = (historico || [])
    .map(m => `${m.deMim ? 'ATENDENTE' : 'CONTATO'}: ${String(m.texto || '').trim()}`)
    .filter(l => l.length > 12).join('\n');
  const perguntas = faltam.map(p => {
    const ops = (p.opcoes || []).map(o => `      "${o.id}" = ${o.rotulo}`).join('\n');
    return `  ${p.chave}: ${p.texto}\n${ops}`;
  }).join('\n\n');
  return {
    faltam: faltam.map(p => p.chave),
    prompt: [
      'Você lê uma conversa de WhatsApp entre uma empresa e um contato, e responde',
      'o que o CONTATO disse sobre cada item abaixo.',
      '',
      'REGRAS, e elas valem mais que completar o formulário:',
      '- Responda APENAS o que o contato disse com estas palavras ou equivalentes diretos.',
      '- Para cada resposta, copie o TRECHO EXATO da conversa que a sustenta.',
      '- Não há trecho que sustente? Deixe a resposta como null. Isso é o esperado,',
      '  e é melhor que inventar.',
      '- Não deduza por contexto, por ramo da empresa nem por probabilidade.',
      '',
      'ITENS:',
      perguntas,
      '',
      'CONVERSA:',
      conversa,
      '',
      'Responda em JSON, exatamente neste formato:',
      '{ "' + (faltam[0]?.chave || 'chave') + '": { "resposta": "id_da_opcao_ou_null", "trecho": "texto copiado da conversa" } }',
    ].join('\n'),
  };
}

/**
 * Confere o que a IA devolveu.
 *
 * Duas recusas, e as duas importam:
 *   - id que não existe no roteiro;
 *   - trecho que NÃO está na conversa. É a checagem que transforma "cite a
 *     fonte" de pedido educado em regra: o modelo pode escrever qualquer coisa
 *     no campo, mas o texto precisa existir de verdade no histórico.
 */
function conferirExtracao(config, bruto, historico) {
  const texto = (historico || []).map(m => String(m.texto || '')).join('\n').toLowerCase();
  const normalizar = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const alvo = normalizar(texto);
  const aceitas = {}, recusadas = [];
  for (const p of config.perguntas || []) {
    const item = bruto && bruto[p.chave];
    if (!item || item.resposta == null || item.resposta === 'null') continue;
    const op = (p.opcoes || []).find(o => o.id === item.resposta);
    if (!op) { recusadas.push({ chave: p.chave, motivo: 'opção inexistente', valor: item.resposta }); continue; }
    const trecho = normalizar(item.trecho);
    if (!trecho) { recusadas.push({ chave: p.chave, motivo: 'sem trecho' }); continue; }
    if (!alvo.includes(trecho)) {
      recusadas.push({ chave: p.chave, motivo: 'trecho não está na conversa', valor: item.trecho });
      continue;
    }
    aceitas[p.chave] = { resposta: op.id, rotulo: op.rotulo, trecho: item.trecho };
  }
  return { aceitas, recusadas };
}

module.exports = { CANAIS, STATUS, VARIAVEIS_EMPRESA, VARIAVEIS_CONTEXTO, render, variaveisDesconhecidas,
                   pontuar, temPorte, resumo, validar, promptExtracao, conferirExtracao };
