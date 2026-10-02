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
 * Onde o lead está no roteiro, seguindo as ETAPAS (29/09).
 *
 * As perguntas são etapas em sequência. Cada resposta pode:
 *   - encerrar o roteiro (`encerra`): o lead está desqualificado;
 *   - pular para uma etapa mais adiante (`vaiPara`, a chave dela). Só para
 *     frente, e é isso que impede o roteiro de virar laço (ver `validar`).
 * Sem desvio, segue para a próxima etapa da lista.
 *
 * O caminho termina ao encerrar ou ao passar da última etapa. No fim, o lead
 * está qualificado se os pontos DO CAMINHO chegaram ao corte. Resposta de
 * etapa fora do caminho (um desvio pulou) não conta.
 *
 * Devolve { etapa, fim, resultado, caminho, pontos, corte }: `etapa` é a
 * pergunta que falta responder, ou null no fim.
 */
function estado(config, respostas = {}) {
  const perguntas = Array.isArray(config?.perguntas) ? config.perguntas : [];
  const corte = Number.isFinite(Number(config?.corte)) ? Number(config.corte) : 2;
  const indice = new Map(perguntas.map((p, i) => [p.chave, i]));
  const caminho = [];
  let pontos = 0, i = 0;
  while (i < perguntas.length) {
    const p = perguntas[i];
    const escolhido = respostas[p.chave];
    const op = escolhido != null && escolhido !== '' ? (p.opcoes || []).find(o => o.id === escolhido) : null;
    if (!op) return { etapa: p, fim: false, resultado: null, caminho, pontos, corte };
    caminho.push(p.chave);
    pontos += Number(op.peso) || 0;
    if (op.encerra) return { etapa: null, fim: true, resultado: 'desqualificado', caminho, pontos, corte };
    const destino = op.vaiPara && indice.has(op.vaiPara) ? indice.get(op.vaiPara) : i + 1;
    i = destino > i ? destino : i + 1;   // só para frente, mesmo se o dado vier torto
  }
  return { etapa: null, fim: true, resultado: pontos >= corte ? 'qualificado' : 'desqualificado', caminho, pontos, corte };
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

/** Sem acento, sem caixa e com espaço normalizado: é como o lead digita. */
function normalizar(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * A fala do contato como ESCOLHA DE OPÇÃO pela posição na lista (01/10).
 *
 * As opções são oferecidas numeradas, e responder "2" é o caminho mais curto
 * para quem está no celular. Quem decide isso é o Node, e não a IA: o
 * `conferirExtracao` prova a resposta exigindo que o trecho esteja no que o
 * contato escreveu, e um trecho "2" casa com qualquer "2" da conversa — o de um
 * telefone, o de "R$ 20". A prova deixaria de provar justamente na resposta mais
 * fácil de dar.
 *
 * Só a fala que é SÓ o número conta ("2", "2.", "opção 2"). Número no meio de
 * uma frase é texto livre, e vai para a IA como antes. Fora da faixa das opções
 * também: "20" numa pergunta de três respostas é quantidade, não escolha.
 */
function respostaNumerica(etapa, texto) {
  const ops = (etapa && Array.isArray(etapa.opcoes) ? etapa.opcoes : []);
  if (!ops.length) return null;
  const m = normalizar(texto).replace(/[.)\]]+$/, '').match(/^(?:op(?:ca|ça)o\s*|alternativa\s*|n[ºo°]\s*)?(\d{1,2})$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= ops.length ? ops[n - 1].id : null;
}

/** As respostas da etapa como o contato as lê: "1) No chute…". */
function opcoesNumeradas(etapa, render = (s) => s) {
  return (etapa && Array.isArray(etapa.opcoes) ? etapa.opcoes : [])
    .map((o, i) => ({ numero: i + 1, rotulo: render(o.rotulo) }))
    .filter(o => o.rotulo);
}

// Os dois desvios do roteiro (01/10): o contato pede uma PESSOA, ou pede o
// material. Nos dois casos a resposta é nossa e não da IA, porque uma delas
// desliga o atendimento automático e a outra manda um endereço — efeitos que não
// podem depender de o modelo ter obedecido a instrução daquela vez.
//
// Os gatilhos exigem o VERBO junto do objeto, e isso não é zelo: "alguém anota
// em caderno ou planilha" e "o gerente, de uma em uma semana" são respostas
// legítimas do roteiro de alimentação. Com "alguém" ou "gerente" soltos como
// gatilho, responder a etapa do estoque desligaria a IA da conversa.
const RE_ATENDENTE = /\b(atendente|atendimento humano|transferir|me transfere)\b|\b(falar|conversar|falo|converso)\b[^.!?]{0,30}\b(com\s+)?(algu[ée]m|uma pessoa|pessoa|um humano|humano|vendedor|consultor|respons[áa]vel|voc[êe]s?)\b|\b(me liga|me ligue|me ligar|pode ligar|poderia ligar|liga pra mim|chamar algu[ée]m|chama algu[ée]m)\b/i;
const RE_MATERIAL_OBJ = /\b(link|site|p[áa]gina|pagina|app|aplicativo|pdf|arquivo|cat[áa]logo|catalogo|material|endere[çc]o|www|http)\b/i;
const RE_MATERIAL_PEDIDO = /\b(manda|mandar|envia|enviar|passa|passar|tem|teria|qual|quais|quero|queria|gostaria|pode|poderia|cad[êe]|onde|mostra|ver|acessar|baixar|download)\b/i;
// A negação derruba o desvio inteiro, e de propósito ela é grosseira: "não quero
// falar com atendente" não pode desligar a IA. O custo é o falso negativo
// ("não entendi, pode me ligar?" segue com a IA), e ele é o erro mais barato dos
// dois — ninguém fica esperando uma pessoa que não foi chamada.
const RE_NEGACAO = /\bn[ãa]o\b|\bnem\b/i;

/**
 * Qual desvio a fala do contato pede: 'atendente', 'material' ou null.
 *
 * `mensagens` são as duas respostas prontas, e desde 02/10/2026 elas vêm do
 * NÚMERO (`whatsapp_ai_resp_pessoa` e `whatsapp_ai_resp_material`), não do
 * roteiro: quem vê um anúncio e pergunta o link nunca passou por campanha, e
 * o desvio precisava valer para ele também. Só desvia o que está escrito, e a
 * pessoa vence o material — quem escreve "manda o link ou me liga" está
 * pedindo gente.
 */
function desvioPedido(mensagens, texto) {
  const d = mensagens || null;
  if (!d) return null;
  const t = String(texto || '');
  if (!t.trim() || RE_NEGACAO.test(t)) return null;
  if (d.atendente && RE_ATENDENTE.test(t)) return 'atendente';
  if (d.material && RE_MATERIAL_OBJ.test(t)
      && (RE_MATERIAL_PEDIDO.test(t) || normalizar(t).split(' ').length <= 4)) return 'material';
  return null;
}

/**
 * A mensagem que fecha o roteiro, por desfecho (02/10/2026).
 *
 * `fim.qualificado` e `fim.desqualificado` saem LITERAIS para o contato, sem o
 * modelo redigir. É o oposto do `proximoPasso`, que é instrução e a IA
 * reescreve a cada vez: em 01/10 isso produziu "Ótimo, obrigado pelas
 * informações!" e um parágrafo sobre escolher subdomínio que ninguém pediu.
 *
 * Vazio devolve '', e aí o `proximoPasso` continua valendo como antes. Os dois
 * caminhos convivem de propósito: roteiro que já tinha o `proximoPasso` segue
 * funcionando sem ninguém reescrever nada.
 */
function mensagemDeFim(config, resultado) {
  const f = config && config.fim;
  if (!f || !resultado) return '';
  const v = f[resultado];
  return typeof v === 'string' ? v.trim() : '';
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
      // O desvio só vai para uma etapa MAIS ADIANTE: para trás, o roteiro
      // viraria laço e a IA repetiria as mesmas perguntas para sempre.
      if (o.vaiPara) {
        const alvo = (perguntas || []).findIndex(x => x.chave === o.vaiPara);
        if (alvo < 0) p.push(`${onde}: "${o.rotulo || o.id}" pula para uma etapa que não existe`);
        else if (alvo <= i) p.push(`${onde}: "${o.rotulo || o.id}" só pode pular para uma etapa mais adiante`);
      }
    }
  }
  const corte = Number(config?.corte);
  if (!Number.isFinite(corte) || corte < 0) p.push('Corte de qualificação inválido');
  // A mensagem de fim vai LITERAL para o cliente. Um objeto aqui sairia
  // "[object Object]" no WhatsApp dele, e a tela não tem como mostrar esse erro
  // depois de enviado.
  for (const [k, rotulo] of [['qualificado', 'Mensagem para o lead qualificado'],
                             ['desqualificado', 'Mensagem para o lead desqualificado']]) {
    const v = config?.fim?.[k];
    if (v != null && typeof v !== 'string') p.push(`${rotulo}: precisa ser texto`);
  }
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
  // O corte é por texto VAZIO, e não por tamanho da linha montada.
  //
  // Era `l.length > 12` sobre a linha já com o rótulo, e "CONTATO: nao" tem
  // exatamente 12: a resposta curta a uma pergunta fechada era jogada fora antes
  // de chegar ao extrator. Foi o que aconteceu em 30/09 às 17:14, quando o lead
  // respondeu "nao" a "Você sabe quanto cada prato custa?" e o roteiro não andou.
  // "Sim" também tem 12, então nenhuma resposta de uma palavra chegava aqui.
  const conversa = (historico || [])
    .map(m => ({ quem: m.deMim ? 'ATENDENTE' : 'CONTATO', texto: String(m.texto || '').trim() }))
    .filter(m => m.texto).map(m => `${m.quem}: ${m.texto}`).join('\n');
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
      '- Para cada resposta, copie o TRECHO EXATO de uma linha CONTATO: que a sustenta.',
      '  Trecho copiado de uma linha ATENDENTE: é recusado — é a empresa falando.',
      '- LEIA A CONVERSA EM PARES: a linha CONTATO: responde a pergunta que a linha',
      '  ATENDENTE: logo acima fez. Um "não" ou "não sei" depois de "Você sabe quanto',
      '  cada prato custa?" É a resposta dela, e o trecho é esse "não". Ler o par',
      '  pergunta→resposta não é deduzir: é o que a conversa diz.',
      '- Uma confirmação solta ("Sim", "ok", "claro", "bom dia") que NÃO vem depois de',
      '  uma das perguntas abaixo não sustenta resposta nenhuma, e é recusada.',
      '- Só os ids listados em ITENS valem. Nenhum outro, mesmo que descreva melhor o',
      '  que ele disse. A resposta dele não cabe em nenhum id? Então é null.',
      '- "resposta" é o ID entre aspas, como está em ITENS. NÃO é o número da opção:',
      '  a conversa mostra listas numeradas porque é assim que o atendente pergunta,',
      '  e esse número não é o id.',
      '- Não há trecho que sustente? Deixe a resposta como null. Isso é o esperado,',
      '  e é melhor que inventar.',
      '- Não deduza por ramo da empresa nem por probabilidade.',
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
 * Uma confirmação solta, que não sustenta resposta nenhuma.
 *
 * "Sim" existe em quase toda conversa de campanha, porque é assim que o modelo
 * pede para o lead responder. Aceito como trecho, ele sustentaria qualquer
 * opção de qualquer etapa: em 30/09, num ensaio sobre a conversa do 1bit, o
 * "Sim" do lead sustentava "põe preço no prato sem saber o custo".
 *
 * A lista é de confirmação e saudação, e nunca de resposta curta com conteúdo —
 * "não sei" e "ninguém" são respostas de verdade e precisam passar.
 */
const CONFIRMACAO_SOLTA = new Set(['sim', 's', 'ok', 'okay', 'blz', 'beleza', 'claro', 'certo', 'isso',
  'pode', 'pode ser', 'quero', 'bom dia', 'boa tarde', 'boa noite', 'oi', 'olá', 'ola', 'obrigado', 'obrigada']);

/**
 * Confere o que a IA devolveu.
 *
 * Quatro recusas, e todas importam:
 *   - id que não existe no roteiro;
 *   - trecho vazio;
 *   - trecho que é só uma confirmação (ver CONFIRMACAO_SOLTA);
 *   - trecho que NÃO está no que o CONTATO escreveu. É a checagem que transforma
 *     "cite a fonte" de pedido educado em regra: o modelo pode escrever qualquer
 *     coisa no campo, mas o texto precisa existir de verdade na conversa.
 *
 * Só as mensagens do contato entram no alvo. Antes o histórico ia inteiro, então
 * um trecho da própria mensagem da empresa sustentava resposta — e é a empresa
 * que escreve "calcula o custo de cada prato pela ficha técnica" na campanha.
 */
function conferirExtracao(config, bruto, historico) {
  // Sem acento nos dois lados. O lead digita no celular e escreve "ninguem
  // controla o estoque"; o modelo copia o trecho ortograficamente correto,
  // "ninguém", e a comparação literal recusava a resposta certa — duas vezes
  // seguidas em 30/09, no ensaio do ciclo. É o mesmo critério do filtro de
  // órgão da tela de Interesses, e não afrouxa nada: é a mesma palavra.
  const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  const alvo = normalizar((historico || []).filter(m => !m.deMim).map(m => String(m.texto || '')).join('\n'));
  const aceitas = {}, recusadas = [];
  for (const p of config.perguntas || []) {
    const item = bruto && bruto[p.chave];
    if (!item || item.resposta == null || item.resposta === 'null') continue;
    const ops = p.opcoes || [];
    let op = ops.find(o => o.id === item.resposta);
    // A IA devolve o NÚMERO DA POSIÇÃO no lugar do id, e isso não é descuido
    // dela: desde 01/10 a conversa está cheia das listas numeradas que nós mesmos
    // oferecemos ("1) Dono, 2) Gerente…"), e o modelo copia o padrão que lê. Em
    // 01/10 às 15:20 o lead escreveu "eu sou o dono", a groq respondeu
    // `resposta: "1"`, o id não existia e a última etapa do roteiro travou: a IA
    // repetiu a pergunta, inventou outra fora do roteiro e o link nunca saiu.
    // Aceitar a posição não afrouxa a prova — ela é o TRECHO, que continua tendo
    // de estar no que o contato escreveu e não pode ser só um número.
    if (!op) {
      const n = Number(String(item.resposta).trim());
      if (Number.isInteger(n) && n >= 1 && n <= ops.length) op = ops[n - 1];
    }
    if (!op) { recusadas.push({ chave: p.chave, motivo: 'opção inexistente', valor: item.resposta }); continue; }
    // O rótulo é do nosso próprio formato, e o modelo copia a linha inteira.
    // Em 30/09, às 16:58, a groq acertou a resposta do lead e mandou o trecho
    // como "CONTATO: pelo preço geral do mercado" — recusado, porque o texto
    // gravado não tem o rótulo. Tirá-lo é o certo: quem pediu "copie o trecho
    // exato" de uma linha rotulada foi o prompt. Uma linha de ATENDENTE segue
    // recusada, porque o alvo tem só as falas do contato.
    const trecho = normalizar(String(item.trecho || '').replace(/^\s*(CONTATO|ATENDENTE)\s*:\s*/i, ''));
    if (!trecho) { recusadas.push({ chave: p.chave, motivo: 'sem trecho' }); continue; }
    if (CONFIRMACAO_SOLTA.has(trecho.replace(/[.!?,;]+$/, ''))) {
      recusadas.push({ chave: p.chave, motivo: 'trecho é só uma confirmação', valor: item.trecho });
      continue;
    }
    // Trecho que é só número não prova nada, e com as opções numeradas (01/10)
    // isso deixou de ser hipótese: um "2" casa com qualquer "2" da conversa — o de
    // um telefone, o de "R$ 20" —, então o `alvo.includes` abaixo passaria sempre.
    // A escolha legítima pelo número já foi resolvida antes, sem IA, em
    // `roteiro-conversa.resolverNumero`; aqui ela só pode ser invenção do modelo.
    if (/^\d{1,3}[.)]?$/.test(trecho)) {
      recusadas.push({ chave: p.chave, motivo: 'trecho é só um número', valor: item.trecho });
      continue;
    }
    if (!alvo.includes(trecho)) {
      recusadas.push({ chave: p.chave, motivo: 'trecho não está no que o contato escreveu', valor: item.trecho });
      continue;
    }
    aceitas[p.chave] = { resposta: op.id, rotulo: op.rotulo, trecho: item.trecho };
  }
  return { aceitas, recusadas };
}

module.exports = { CANAIS, STATUS, VARIAVEIS_EMPRESA, VARIAVEIS_CONTEXTO, render, variaveisDesconhecidas,
                   pontuar, estado, temPorte, resumo, validar, promptExtracao, conferirExtracao,
                   respostaNumerica, opcoesNumeradas, desvioPedido, mensagemDeFim };
