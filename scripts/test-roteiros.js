/**
 * Roteiros de venda: pontuação, porte, variáveis e o resumo.
 *
 * ── O que está guardado ────────────────────────────────────────────────────
 *
 * 1. A SOMA. O peso é tabela, e quem soma é o Node. Se um dia alguém pedir a
 *    nota ao modelo, estas checagens continuam exigindo o número da tabela.
 * 2. O PORTE. O plano vendido em campo é o mais caro, e sem o corte o vendedor
 *    agenda meia hora do dono com quem não vai pagar. Mas o corte não pode
 *    reprovar quem simplesmente não contou os caixas.
 * 3. A VARIÁVEL SEM VALOR. O roteiro é lido na frente do cliente. `{{ano}}` sem
 *    valor viraria um buraco no meio da frase, e por isso é recusado ao salvar
 *    em vez de trocado por vazio.
 * 4. O RESUMO. É o passo que mais falha no papel, e o que justifica o recurso:
 *    ele precisa sair pronto das respostas marcadas.
 */
const path = require('path');

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const R = require('../roteiros');
const { CONFIG } = require('./semear-roteiro-visita');

const EMPRESA = { razaoSocial: '1 BIT GESTAO E CONSULTORIA LTDA', nomeFantasia: '1BIT',
                  cidade: 'MARABA', uf: 'PA', telefone: '9491759088' };

// ==================== A. o roteiro que vai a produção ====================

t('A1. o roteiro de visita passa na validacao', () => {
  const p = R.validar(CONFIG);
  assert(p.length === 0, p.join(' | '));
});

t('A2. nenhuma variavel do texto fica sem valor', () => {
  // A que mais importa: o vendedor lê isto em voz alta, na loja.
  assert(R.variaveisDesconhecidas(CONFIG).length === 0,
    'sem valor: ' + R.variaveisDesconhecidas(CONFIG).join(', '));
  const texto = R.render(CONFIG.abertura, { empresa: EMPRESA, valores: CONFIG.valores,
    contexto: { vendedorNome: 'Guilherme' } });
  assert(!/\{\{/.test(texto), 'sobrou variável no texto: ' + texto);
  assert(/Guilherme/.test(texto) && /1BIT/.test(texto) && /MARABA\/PA/.test(texto), texto);
});

t('A3. o preco lido e o do plano que tem caixa', () => {
  // O erro que motivou a revisão: "começa em R$ 297" é verdade sobre a tabela
  // e mentira sobre quem precisa de PDV.
  const o = CONFIG.objecoes.find(x => x.chave === 'preco');
  const txt = R.render(o.resposta, { empresa: EMPRESA, valores: CONFIG.valores });
  assert(/R\$ 1\.497/.test(txt), 'a objeção de preço não diz o valor do plano vendido');
  assert(!/começa em/i.test(txt), 'voltou o "começa em", que aponta para o plano sem caixa');
});

// ==================== B. a soma ====================

t('B1. soma os pesos das respostas marcadas', () => {
  const r = R.pontuar(CONFIG, { controle: 'caderno', suporte: 'chat' });
  assert(r.pontos === 4, `somou ${r.pontos}, esperado 4`);
  assert(r.qualificado, 'quatro pontos deveria passar do corte de 2');
});

t('B2. resposta sem dor nao soma e nao inventa dor', () => {
  const r = R.pontuar(CONFIG, { controle: 'atende', suporte: 'rapido', nota: 'tranquilo',
                                lucro: 'sabe', cobranca: 'processo' });
  assert(r.pontos === 0, `somou ${r.pontos} num cliente sem dor nenhuma`);
  assert(!r.qualificado, 'cliente sem dor apareceu como qualificado');
  assert(r.dores.length === 0, 'inventou dor: ' + r.dores.join(', '));
});

t('B3. o corte de 2 e o limite, e ele vale no empate', () => {
  assert(R.pontuar(CONFIG, { lucro: 'nao_sabe' }).qualificado === false, 'um ponto não qualifica');
  assert(R.pontuar(CONFIG, { lucro: 'nao_sabe', cobranca: 'dono' }).qualificado === true,
    'dois pontos precisam qualificar');
});

t('B4. resposta que nao existe no roteiro e DENUNCIADA', () => {
  // Acontece quando alguém edita o roteiro por baixo de visitas já preenchidas.
  // Somar zero calado esconderia o problema.
  const r = R.pontuar(CONFIG, { controle: 'inventado' });
  assert(r.pontos === 0, 'somou peso de resposta inexistente');
  assert(r.desconhecidas.includes('controle=inventado'), 'não avisou: ' + JSON.stringify(r.desconhecidas));
});

t('B5. o maximo possivel e o teto real do roteiro', () => {
  const r = R.pontuar(CONFIG, {});
  assert(r.maximo === 9, `o teto veio ${r.maximo}, esperado 9`);
  assert(r.faltam.length === 5, 'com nada respondido, as cinco deveriam faltar');
});

// ==================== C. o porte ====================

t('C1. dois caixas OU oito funcionarios liberam a visita', () => {
  assert(R.temPorte(CONFIG, { caixas: 2, funcionarios: 3 }), 'dois caixas deveria liberar');
  assert(R.temPorte(CONFIG, { caixas: 1, funcionarios: 8 }), 'oito funcionários deveria liberar');
  assert(R.temPorte(CONFIG, { caixas: 1, funcionarios: 2, maisDeUmPonto: true }),
    'mais de um ponto deveria liberar');
});

t('C2. um caixa e dois funcionarios NAO liberam', () => {
  // É o mercadinho que não paga o plano com PDV. Sem este corte, o vendedor
  // gasta a visita e ainda ocupa meia hora da agenda do dono.
  assert(!R.temPorte(CONFIG, { caixas: 1, funcionarios: 2 }), 'liberou quem está abaixo do corte');
});

t('C3. quem nao contou caixa nenhum NAO e reprovado', () => {
  // Reprovar por campo em branco faria o vendedor inventar número para seguir.
  assert(R.temPorte(CONFIG, {}), 'reprovou por falta de informação');
  assert(R.temPorte({}, { caixas: 1 }), 'roteiro sem regra de porte não deveria barrar ninguém');
});

// ==================== D. o resumo ====================

const VISITA = {
  empresa: 'Mercado Sao Jose', segmento: 'mercado', decisor: 'Sr. Antonio',
  whatsapp: '5594999990001', contador: 'Escritorio Contabil Silva',
  respostas: { controle: 'caderno', suporte: 'ninguem', nota: 'nao_emite', lucro: 'nao_sabe',
               cobranca: 'dono' },
  videoAssistido: 1, reacaoVideo: 'quando mostrou o estoque', objecao: 'pensar',
  status: 'agendado',
};

t('D1. o resumo sai pronto, com tudo que o roteiro exige', () => {
  const txt = R.resumo(CONFIG, VISITA, { quando: 'terça, 22/09 às 14:00' });
  for (const [o_que, regex] of [
    ['empresa', /Mercado Sao Jose/], ['segmento', /mercado/], ['decisor', /Sr\. Antonio/],
    ['whatsapp', /5594999990001/], ['pontuação', /8 de 9/], ['contador', /Escritorio Contabil Silva/],
    ['reação ao vídeo', /quando mostrou o estoque/], ['objeção', /Vou pensar/],
    ['status', /Agendado/], ['horário', /22\/09 às 14:00/],
  ]) assert(regex.test(txt), `o resumo não traz ${o_que}:\n${txt}`);
});

t('D2. as dores aparecem em texto, e nao em codigo', () => {
  const txt = R.resumo(CONFIG, VISITA);
  assert(/controla venda e estoque no caderno/.test(txt), 'a dor veio como código');
  assert(!/caderno'|nao_emite/.test(txt), 'vazou id de opção para o resumo:\n' + txt);
});

t('D3. resposta sem dor nao entra na lista de dores', () => {
  const txt = R.resumo(CONFIG, { ...VISITA, respostas: { controle: 'atende', lucro: 'nao_sabe' } });
  assert(!/Dores:[\s\S]*atende/.test(txt), 'entrou resposta neutra na lista de dores');
  assert(/fecha o mês sem saber se lucrou/.test(txt), 'a dor real não apareceu');
});

t('D4. visita fraca diz que esta abaixo do corte', () => {
  const txt = R.resumo(CONFIG, { ...VISITA, respostas: { lucro: 'nao_sabe' }, status: 'descartado',
                                 motivo: 'sem dor' });
  assert(/abaixo do corte/.test(txt), 'não avisou que a visita não qualificou:\n' + txt);
  assert(/Descartado \(sem dor\)/.test(txt), 'o motivo do descarte não apareceu');
});

t('D5. video nao assistido e dito, e nao omitido', () => {
  const txt = R.resumo(CONFIG, { ...VISITA, videoAssistido: 0, reacaoVideo: null });
  assert(/Vídeo: não assistido/.test(txt), 'a ausência do vídeo sumiu do resumo');
});

// ==================== E. a validação reprova ====================

t('E1. roteiro com variavel sem valor e RECUSADO', () => {
  const ruim = { ...CONFIG, abertura: 'Atendemos desde {{anoQualquer}}.' };
  const p = R.validar(ruim);
  assert(p.some(x => /anoQualquer/.test(x)), 'aceitou variável que ninguém resolve: ' + p.join(' | '));
});

t('E2. pergunta com uma resposta so e RECUSADA', () => {
  const ruim = { ...CONFIG, perguntas: [{ chave: 'x', texto: 'Tudo bem?',
    opcoes: [{ id: 'a', rotulo: 'Sim', peso: 1 }] }] };
  assert(R.validar(ruim).some(x => /duas respostas/.test(x)), 'aceitou pergunta sem escolha');
});

t('E3. peso negativo e chave repetida sao RECUSADOS', () => {
  const p1 = R.validar({ ...CONFIG, perguntas: [{ chave: 'x', texto: 'a',
    opcoes: [{ id: 'a', rotulo: 'A', peso: -1 }, { id: 'b', rotulo: 'B', peso: 1 }] }] });
  assert(p1.some(x => /peso inválido/.test(x)), 'aceitou peso negativo');
  const q = { chave: 'x', texto: 'a', opcoes: [{ id: 'a', rotulo: 'A', peso: 1 },
                                               { id: 'b', rotulo: 'B', peso: 0 }] };
  const p2 = R.validar({ ...CONFIG, perguntas: [q, { ...q }] });
  assert(p2.some(x => /chave repetida/.test(x)), 'aceitou duas perguntas com a mesma chave');
});

// ==================== F. a extração pela IA ====================

const WA = require('./semear-roteiro-whatsapp').CONFIG;

const CONVERSA = [
  { deMim: false, texto: 'Oi, vi a mensagem de voces sobre licitacao' },
  { deMim: true, texto: 'Oi! Sua empresa ja vende para orgao publico?' },
  { deMim: false, texto: 'ja vendi umas vezes mas parei, deu muito trabalho' },
  { deMim: true, texto: 'Entendo. E como voce ficava sabendo dos editais?' },
  { deMim: false, texto: 'olhava os portais na mao quando sobrava tempo' },
];

t('F1. o roteiro de whatsapp passa na validacao', () => {
  const p = R.validar(WA);
  assert(p.length === 0, p.join(' | '));
});

t('F2. o pedido a IA leva so as perguntas que faltam', () => {
  const { prompt, faltam } = R.promptExtracao(WA, CONVERSA, { vende_governo: 'parou' });
  assert(!faltam.includes('vende_governo'), 'repetiu a pergunta que já tinha resposta');
  assert(faltam.length === 4, `pediu ${faltam.length} perguntas`);
  assert(/copie o TRECHO EXATO/i.test(prompt), 'o pedido não exige a citação');
  assert(/Deixe a resposta como null/.test(prompt), 'não autoriza deixar em branco');
});

t('F3. resposta com trecho REAL e aceita', () => {
  const r = R.conferirExtracao(WA, {
    vende_governo: { resposta: 'parou', trecho: 'ja vendi umas vezes mas parei' },
    acha_edital: { resposta: 'na_mao', trecho: 'olhava os portais na mao' },
  }, CONVERSA);
  assert(Object.keys(r.aceitas).length === 2, JSON.stringify(r));
  assert(r.aceitas.vende_governo.rotulo === 'Já vendeu e parou', JSON.stringify(r.aceitas));
});

t('F4. resposta com trecho INVENTADO e recusada', () => {
  // O modo de falha que mais importa: a IA preenche as cinco de uma conversa de
  // duas linhas, e a nota fica alta sem nada por trás.
  const r = R.conferirExtracao(WA, {
    habilitacao: { resposta: 'varias', trecho: 'ja perdi varias por certidao vencida' },
  }, CONVERSA);
  assert(Object.keys(r.aceitas).length === 0, 'aceitou resposta que ninguém disse');
  assert(r.recusadas[0].motivo === 'trecho não está na conversa', JSON.stringify(r.recusadas));
});

t('F5. resposta sem trecho nenhum e recusada', () => {
  const r = R.conferirExtracao(WA, { le_edital: { resposta: 'desiste', trecho: '' } }, CONVERSA);
  assert(Object.keys(r.aceitas).length === 0, 'aceitou resposta sem citação');
  assert(r.recusadas[0].motivo === 'sem trecho', JSON.stringify(r.recusadas));
});

t('F6. opcao que nao existe no roteiro e recusada', () => {
  const r = R.conferirExtracao(WA, {
    vende_governo: { resposta: 'talvez', trecho: 'ja vendi umas vezes mas parei' },
  }, CONVERSA);
  assert(r.recusadas[0].motivo === 'opção inexistente', JSON.stringify(r.recusadas));
});

t('F7. o que a IA aceitou pontua pela MESMA tabela', () => {
  // Nada de nota vinda do modelo: o peso é o do roteiro, como no preenchimento
  // à mão.
  const r = R.conferirExtracao(WA, {
    vende_governo: { resposta: 'parou', trecho: 'ja vendi umas vezes mas parei' },
    acha_edital: { resposta: 'na_mao', trecho: 'olhava os portais na mao' },
  }, CONVERSA);
  const respostas = Object.fromEntries(Object.entries(r.aceitas).map(([k, v]) => [k, v.resposta]));
  const p = R.pontuar(WA, respostas);
  assert(p.pontos === 4, `somou ${p.pontos}, esperado 4`);
  assert(p.dores.length === 2, 'as dores não vieram do roteiro');
});

t('F8. conversa vazia nao produz resposta nenhuma', () => {
  const r = R.conferirExtracao(WA, { vende_governo: { resposta: 'parou', trecho: 'qualquer coisa' } }, []);
  assert(Object.keys(r.aceitas).length === 0, 'extraiu resposta de conversa vazia');
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
