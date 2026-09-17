/**
 * Fluxo do ORÇAMENTO no celular — correções de 2026-09-12.
 *
 * Nasceu de um teste real num iPhone com o ERP instalado como PWA, no
 * ORC-2026-00003. O que apareceu lá não aparecia em teste nenhum:
 *
 *   - `Can't find variable: PEDIDO` ao usar o menu de ações;
 *   - "Enviar via WhatsApp" que não enviava nada e voltava para a aba Itens;
 *   - lista de separação oferecida num orçamento ainda não aprovado.
 *
 * ── O bloco A é o que faltava ───────────────────────────────────────────────
 *
 * Nenhuma verificação deste projeto lia o JavaScript das telas procurando
 * variável inexistente. `node --check` (o verify) só pergunta se o arquivo
 * PARSEIA — e `PEDIDO.numero` parseia perfeitamente; o erro só nasce quando a
 * linha executa. Por isso o defeito atravessou o verify verde e foi descoberto
 * por uma pessoa com o celular na mão.
 *
 * O bloco A monta a árvore sintática com o `acorn`, coleta tudo que o script
 * DECLARA e tudo que ele REFERENCIA, e reprova a diferença que não for um
 * global conhecido. É análise real, não busca de texto: renomear a variável não
 * engana o teste.
 *
 * ── O que os outros blocos cobrem ───────────────────────────────────────────
 *
 *   B. o menu não confunde orçamento com pedido, e não oferece expedição antes
 *      de o cliente ter aprovado nada;
 *   C. ponta a ponta com banco descartável: orçamento salvo, PDF, link público,
 *      revogação — e a prova de que ele CONTINUA orçamento no fim;
 *   D. a porta pública: sem sessão, sem enumeração, sem dado interno.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const acorn = require('acorn');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const TMP = '/tmp/test-orcamento-pwa';
fs.mkdirSync(TMP, { recursive: true });

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };
const ler = (p) => fs.readFileSync(path.join(PUB, p), 'utf8');

const PEDIDO = ler('comercial/pedido.html');
const LISTA = ler('comercial/pedidos.html');
const PUBLICA = ler('auth/orcamento-comercial.html');
const ROTAS = fs.readFileSync(path.join(RAIZ, 'pedidos-routes.js'), 'utf8');

// ============================================================================
// A. Nenhuma variável inexistente — a regressão do `Can't find variable`
// ============================================================================

/** Todo o JavaScript embutido numa tela, concatenado como o navegador o vê. */
function scriptsInline(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).join('\n;\n');
}

/** Percorre TODOS os nós do AST, sem depender de acorn-walk. */
function percorrer(no, visitar, pai) {
  if (!no || typeof no.type !== 'string') return;
  visitar(no, pai);
  for (const k of Object.keys(no)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
    const v = no[k];
    if (Array.isArray(v)) v.forEach((f) => percorrer(f, visitar, no));
    else if (v && typeof v.type === 'string') percorrer(v, visitar, no);
  }
}

/** Nomes que um padrão de desestruturação/parâmetro liga. */
function nomesDoPadrao(no, out) {
  if (!no) return;
  if (no.type === 'Identifier') out.add(no.name);
  else if (no.type === 'ObjectPattern') no.properties.forEach((p) =>
    nomesDoPadrao(p.type === 'RestElement' ? p.argument : p.value, out));
  else if (no.type === 'ArrayPattern') no.elements.forEach((e) => nomesDoPadrao(e, out));
  else if (no.type === 'AssignmentPattern') nomesDoPadrao(no.left, out);
  else if (no.type === 'RestElement') nomesDoPadrao(no.argument, out);
}

/**
 * Tudo que o script declara: var/let/const, funções, parâmetros, classes.
 *
 * Sem `else if` entre o nome e os parâmetros: uma `function baixarPdf(btn)` tem
 * as DUAS coisas, e encadear os ramos fazia o teste esquecer todo parâmetro de
 * função nomeada — `btn` virava "variável inexistente" e o resultado enchia de
 * falso positivo.
 */
function declaracoes(ast) {
  const out = new Set();
  percorrer(ast, (no) => {
    if (no.type === 'VariableDeclarator') nomesDoPadrao(no.id, out);
    if (/^(Function|Class)(Declaration|Expression)$/.test(no.type) && no.id) out.add(no.id.name);
    if (Array.isArray(no.params)) no.params.forEach((p) => nomesDoPadrao(p, out));
    if (no.type === 'CatchClause' && no.param) nomesDoPadrao(no.param, out);
    if (no.type === 'ImportDefaultSpecifier' || no.type === 'ImportSpecifier') out.add(no.local.name);
  });
  return out;
}

/**
 * Identificadores em posição de LEITURA.
 *
 * Fora dali um `Identifier` não é referência a variável nenhuma: `p.numero` tem
 * `numero` como nome de propriedade, `{ total: 1 }` tem `total` como chave.
 * Contá-los encheria o resultado de falso positivo e o teste seria descartado.
 */
function referencias(ast) {
  const out = new Map();
  percorrer(ast, (no, pai) => {
    if (no.type !== 'Identifier' || !pai) return;
    if (pai.type === 'MemberExpression' && pai.property === no && !pai.computed) return;
    if (pai.type === 'Property' && pai.key === no && !pai.computed) return;
    if (pai.type === 'MethodDefinition' && pai.key === no && !pai.computed) return;
    if (/Function|Class/.test(pai.type) && pai.id === no) return;
    if (pai.type === 'VariableDeclarator' && pai.id === no) return;
    if (pai.type === 'LabeledStatement' || pai.type === 'BreakStatement'
        || pai.type === 'ContinueStatement') return;
    if (pai.params && pai.params.includes(no)) return;
    if (pai.type === 'CatchClause' && pai.param === no) return;
    if (!out.has(no.name)) out.set(no.name, no.start);
  });
  return out;
}

/** Globais que o navegador entrega prontos. */
const GLOBAIS_JS = new Set(Object.getOwnPropertyNames(vm.runInNewContext('this')));
const GLOBAIS_NAVEGADOR = new Set([
  'window', 'document', 'location', 'navigator', 'history', 'screen', 'console',
  'fetch', 'alert', 'confirm', 'prompt', 'setTimeout', 'clearTimeout', 'requestAnimationFrame',
  'setInterval', 'clearInterval', 'localStorage', 'sessionStorage', 'getComputedStyle',
  'URL', 'URLSearchParams', 'Blob', 'File', 'FormData', 'FileReader', 'Image', 'Option',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'AbortController', 'Headers',
  'Response', 'Request', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
  'matchMedia', 'scrollTo', 'open', 'close', 'print', 'btoa', 'atob', 'structuredClone',
  'crypto', 'performance', 'CSS', 'Node', 'Element', 'HTMLElement', 'DOMParser', 'self',
  'event', 'top', 'parent', 'frames', 'name', 'status', 'origin', 'length', 'closed',
]);

/** Globais que os `<script src>` da tela publicam. */
function globaisDosScripts(html) {
  const out = new Set();
  for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+\.js)"/g)) {
    const arq = path.join(PUB, m[1].replace(/^\//, ''));
    if (!fs.existsSync(arq)) continue;
    const ast = acorn.parse(fs.readFileSync(arq, 'utf8'), { ecmaVersion: 2022 });
    // Só o topo: o que está dentro de uma função não vira global.
    for (const no of ast.body) {
      if (no.type === 'FunctionDeclaration' && no.id) out.add(no.id.name);
      else if (no.type === 'ClassDeclaration' && no.id) out.add(no.id.name);
      else if (no.type === 'VariableDeclaration') no.declarations.forEach((d) => nomesDoPadrao(d.id, out));
      else if (no.type === 'ExpressionStatement' && no.expression.type === 'AssignmentExpression'
               && no.expression.left.type === 'Identifier') out.add(no.expression.left.name);
    }
    // `window.PoliticaPrazo = {...}` publica um global tanto quanto uma
    // declaração no topo — e vem de DENTRO de um IIFE, que é como
    // politica-prazo.js e optica/pedido-tab.js expõem o que a tela usa. Por
    // isso a varredura aqui é profunda, e não só do corpo do módulo.
    percorrer(ast, (no) => {
      if (no.type !== 'AssignmentExpression') return;
      const alvo = no.left;
      if (alvo.type === 'MemberExpression' && !alvo.computed
          && alvo.object.type === 'Identifier'
          && (alvo.object.name === 'window' || alvo.object.name === 'globalThis')) {
        out.add(alvo.property.name);
      }
    });
  }
  return out;
}

/**
 * Nomes referenciados por uma tela sem estarem declarados em lugar nenhum.
 *
 * É o coração do teste: `PEDIDO` cairia exatamente aqui.
 */
function indefinidosDaTela(html, extras = []) {
  const fonte = scriptsInline(html);
  const ast = acorn.parse(fonte, { ecmaVersion: 2022, allowReturnOutsideFunction: true });
  const conhecidos = new Set([
    ...declaracoes(ast), ...globaisDosScripts(html),
    ...GLOBAIS_JS, ...GLOBAIS_NAVEGADOR, ...extras,
  ]);
  const fora = [];
  for (const [nome, pos] of referencias(ast)) {
    if (conhecidos.has(nome)) continue;
    fora.push(`${nome} (linha ${fonte.slice(0, pos).split('\n').length} do script inline)`);
  }
  return fora;
}

t('A1. pedido.html nao referencia nenhuma variavel inexistente', () => {
  // `PEDIDO` estava em duas linhas: no nome do arquivo do PDF e no da lista de
  // separação. Nas duas o objeto certo sempre foi `pedidoAtual`.
  const fora = indefinidosDaTela(PEDIDO);
  assert(fora.length === 0,
    'a tela usa variável que nunca é declarada — daria ReferenceError:\n      ' + fora.join('\n      '));
});

t('A2. pedidos.html nao referencia nenhuma variavel inexistente', () => {
  const fora = indefinidosDaTela(LISTA);
  assert(fora.length === 0, 'variável inexistente na listagem:\n      ' + fora.join('\n      '));
});

t('A3. a pagina publica nao referencia variavel inexistente', () => {
  // Aqui o custo de um ReferenceError é maior: quem abre é o CLIENTE, não tem
  // conta, e a tela em branco não lhe dá nenhuma saída.
  const fora = indefinidosDaTela(PUBLICA);
  assert(fora.length === 0, 'variável inexistente na página pública:\n      ' + fora.join('\n      '));
});

t('A4. o analisador realmente pega o defeito (sabotagem)', () => {
  // Sem esta prova, A1 poderia estar passando por não enxergar nada. Reinjeta o
  // defeito original e exige a reprovação.
  const sabotado = PEDIDO.replace(
    'return (pedidoAtual && pedidoAtual.numero) ? String(pedidoAtual.numero) : \'documento\';',
    'return (PEDIDO && PEDIDO.numero) ? String(PEDIDO.numero) : \'documento\';');
  assert(sabotado !== PEDIDO, 'a sabotagem não encontrou o trecho — reveja o teste, não o código');
  const fora = indefinidosDaTela(sabotado);
  assert(fora.some((f) => f.startsWith('PEDIDO ')),
    'o analisador NÃO detectou o `PEDIDO` reinjetado — o teste A1 não prova nada');
});

t('A5. as funcoes do menu de acoes existem de verdade', () => {
  // Um `onclick` aponta para um nome resolvido só no clique: errar o nome não
  // quebra nada até alguém tocar no botão.
  const PALAVRAS = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'catch', 'function']);
  const chamadas = new Set();
  for (const m of PEDIDO.matchAll(/onclick="([^"]+)"/g)) {
    // `(?<![.\w])` descarta método de objeto (`this.select()`): quem resolve
    // esse nome é o objeto, não o escopo global.
    for (const c of m[1].matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!PALAVRAS.has(c[1])) chamadas.add(c[1]);
    }
  }
  const fonte = scriptsInline(PEDIDO);
  const ast = acorn.parse(fonte, { ecmaVersion: 2022, allowReturnOutsideFunction: true });
  const definidas = new Set([...declaracoes(ast), ...globaisDosScripts(PEDIDO),
                             ...GLOBAIS_JS, ...GLOBAIS_NAVEGADOR]);
  const ausentes = [...chamadas].filter((c) => !definidas.has(c));
  assert(ausentes.length === 0, 'onclick chama função que não existe: ' + ausentes.join(', '));
});

// ============================================================================
// B. O menu fala do documento que está aberto
// ============================================================================

t('B1. o titulo do painel segue o documento', () => {
  assert(!/<h3>Ações do pedido<\/h3>/.test(PEDIDO),
    'o título voltou a ser fixo — um orçamento diria "Ações do pedido"');
  assert(/drawerTitulo/.test(PEDIDO), 'o título perdeu o id');
  const fn = /function abrirDrawer\(\)\{[\s\S]*?\n\}/.exec(PEDIDO);
  assert(fn, 'abrirDrawer sumiu');
  assert(/Ações do orçamento/.test(fn[0]) && /Ações do pedido/.test(fn[0]),
    'o título não alterna entre orçamento e pedido');
});

t('B2. orcamento NAO oferece lista de separacao', () => {
  const fn = /function renderDrawerBody\(\)\{[\s\S]*?\n\}/.exec(PEDIDO);
  assert(fn, 'renderDrawerBody sumiu');
  assert(/const separacaoItems = ehOrcamento \? \[\]/.test(fn[0]),
    'a lista de separação voltou a aparecer em orçamento não aprovado');
  // Continua existindo para pedido: o estoque precisa dela.
  assert(/Visualizar lista de separação/.test(fn[0]), 'a separação sumiu também do pedido');
});

t('B3. o cabecalho tem SO Salvar e Acoes', () => {
  // Os atalhos [PDF] e [WhatsApp] chegaram a ficar aqui e foram removidos após
  // o teste real: duplicavam o menu e poluíam um cabeçalho que no celular já
  // divide espaço com número, etiquetas, cliente, data e total.
  const fn = /function renderAcoes\(\)\{[\s\S]*?\n\}/.exec(PEDIDO);
  assert(fn, 'renderAcoes sumiu');
  for (const proibido of ['baixarPdf', 'enviarWhatsApp', 'imprimirPdf',
                          'gerenciarLinkPublico', 'converterModo']) {
    assert(!new RegExp(proibido).test(fn[0]),
      `"${proibido}" voltou ao cabeçalho — o topo é só Salvar e Ações`);
  }
  assert(/salvarHeader\(\)/.test(fn[0]), 'o botão Salvar sumiu do cabeçalho');
  assert(/abrirDrawer\(\)/.test(fn[0]), 'o botão Ações sumiu do cabeçalho');
});

t('B7. os textos visiveis nao chamam orcamento de pedido', () => {
  const fn = /function aplicarNomenclatura\([^)]*\)\{[\s\S]*?\n\}/.exec(PEDIDO);
  assert(fn, 'aplicarNomenclatura sumiu');
  for (const id of ['tituloItens', 'lnkVoltar', 'lblValidade', 'lblCodCliente']) {
    assert(fn[0].includes(id), `"${id}" deixou de ser contextual`);
    assert(new RegExp(`id="${id}"`).test(PEDIDO), `o elemento "${id}" sumiu da tela`);
  }
  // A troca é por interpolação: se alguém fixar "pedido", o orçamento volta a
  // se chamar errado.
  assert(/Itens do \$\{D\}/.test(fn[0]), 'o título dos itens voltou a ser fixo');
  assert(/const D = ehOrcamento \? 'orçamento' : 'pedido'/.test(fn[0]),
    'a palavra deixou de depender do documento');
  assert(/aplicarNomenclatura\(ehOrcamento\)/.test(PEDIDO),
    'renderHeader não aplica mais a nomenclatura');
  // E nada de renomear estrutura por causa de texto de tela.
  assert(/modoDocumento/.test(PEDIDO), 'o campo modoDocumento sumiu — isto era só apresentação');
});

t('B6. as acoes removidas do cabecalho continuam em Acoes', () => {
  // Remover o atalho não pode ter removido a função.
  const fn = /function renderDrawerBody\(\)\{[\s\S]*?\n\}/.exec(PEDIDO)[0];
  for (const [chamada, oque] of [['baixarPdf(this)', 'Baixar PDF'],
                                 ['imprimirPdf(this)', 'Imprimir PDF'],
                                 ['enviarWhatsApp(this)', 'Enviar via WhatsApp'],
                                 ['gerenciarLinkPublico(this)', 'Link público']]) {
    assert(fn.includes(chamada), `"${oque}" saiu do cabeçalho e NÃO está no menu de ações`);
  }
  assert(/converterModo\('pedido'\)/.test(fn), '"Converter em pedido" sumiu do menu');
});

t('B4. a listagem da acesso ao PDF e ao envio', () => {
  assert(/function abrirAcoesLinha/.test(LISTA), 'a listagem não tem menu de ações por linha');
  assert(/function baixarPdfLinha/.test(LISTA), 'não dá para baixar o PDF pela listagem');
  assert(/function whatsappLinha/.test(LISTA), 'não dá para enviar pelo WhatsApp pela listagem');
  assert(/min-height: 44px/.test(LISTA), 'os botões do menu ficam sem alvo de toque no celular');
});

t('B5. os botoes do fluxo de documento nao submetem formulario', () => {
  // Um `<button>` sem `type` é `submit` por omissão: dentro de um formulário
  // ele recarregaria a tela no meio da ação. Hoje estas telas não têm `<form>`,
  // então o risco é futuro — e é justamente por isso que precisa estar travado:
  // quem envolver o painel num formulário amanhã não vai lembrar disto.
  //
  // O alvo são as ações do documento. Os outros ~40 botões da tela são
  // anteriores a esta correção e não fazem parte do pedido.
  const ACOES = ['baixarPdf', 'verPdf', 'imprimirPdf', 'enviarWhatsApp', 'gerenciarLinkPublico',
                 'copiarLinkPublico', 'regerarLinkPublico', 'revogarLinkPublico',
                 'verSeparacao', 'baixarSeparacao', 'imprimirSeparacao',
                 'baixarPdfLinha', 'whatsappLinha', 'abrirAcoesLinha'];
  for (const [nome, html] of [['pedido.html', PEDIDO], ['pedidos.html', LISTA]]) {
    const ruins = [...html.matchAll(/<button(?![^>]*\btype=)[^>]*onclick="([^"]*)"/g)]
      .map((m) => m[1]).filter((oc) => ACOES.some((a) => oc.includes(a + '(')));
    assert(ruins.length === 0,
      `${nome}: ação de documento em botão sem type="button" — ` + ruins.join(' | '));
  }
  assert(!/<form[\s>]/i.test(PEDIDO) && !/<form[\s>]/i.test(LISTA),
    'apareceu um <form> nestas telas: revise TODOS os botões, não só os do fluxo');
});

// ============================================================================
// C. Nenhum pop-up no caminho do compartilhamento
// ============================================================================

t('C1. o WhatsApp NUNCA navega o iframe da tela', () => {
  // ── O defeito que este teste existe para impedir ──────────────────────────
  //
  // `pedido.html` roda dentro do `<iframe id="conteudo">` de `app.html`. Ali
  // `location` é a do IFRAME, e `location.href = 'https://wa.me/…'` tenta
  // carregar o wa.me ENQUADRADO — que responde `x-frame-options: DENY`. O
  // resultado no iPhone foi a tela vazia com a topbar por cima.
  //
  // Verificar "existe location.href" não bastaria: era exatamente isso que a
  // versão quebrada tinha. O que se checa aqui é o CONTEXTO.
  const fn = /function abrirWhatsApp\([^)]*\)\{[\s\S]*?\n\}/.exec(PEDIDO);
  assert(fn, 'abrirWhatsApp sumiu');

  // Nenhuma navegação do WhatsApp pode sair de `location` ou `window.location`
  // sem passar pela janela de topo.
  const cru = /(^|[^.\w])location\.(href|replace|assign)/m.exec(fn[0]);
  assert(!cru, 'navega a própria janela — dentro do shell isso é o IFRAME, e o wa.me recusa ser enquadrado');
  assert(/janelaDeNavegacao\(\)/.test(fn[0]), 'não resolve a janela de topo antes de navegar');

  const jn = /function janelaDeNavegacao\(\)\{[\s\S]*?\n\}/.exec(PEDIDO);
  assert(jn, 'janelaDeNavegacao sumiu');
  assert(/window\.top/.test(jn[0]), 'não usa window.top — continuaria preso ao iframe');
  assert(/location\.origin/.test(jn[0]), 'não confere a origem antes de tocar no topo');
  assert(/catch/.test(jn[0]), 'acesso a window.top sem guarda: lança se a tela for enquadrada por outra origem');

  // O mesmo vale para a listagem, que também roda no iframe.
  const wl = /async function whatsappLinha\([^)]*\)\{[\s\S]*?\n\}/.exec(LISTA);
  assert(wl, 'whatsappLinha sumiu da listagem');
  assert(!/(^|[^.\w])location\.href = url/m.test(wl[0]),
    'a listagem navega o próprio iframe para o wa.me — mesma tela vazia');
});

t('C1b. a folha nativa vem antes, e cancelar nao vira erro', () => {
  const env = /async function enviarWhatsApp\([^)]*\)\{[\s\S]*?\n\}/.exec(PEDIDO)[0];
  assert(/compartilharTexto\(msg\)/.test(env),
    'não tenta a folha nativa — no iPhone é o caminho que não navega nada');
  // A folha tem de ser tentada ANTES do deep link, senão o iOS nunca a vê.
  assert(env.indexOf('compartilharTexto') < env.indexOf('abrirWhatsApp'),
    'a folha nativa é tentada depois do deep link — no iPhone ela nunca seria usada');
  assert(!/window\.open/.test(env), 'enviarWhatsApp voltou a chamar window.open depois do await');

  const ct = /async function compartilharTexto\([^)]*\)\{[\s\S]*?\n\}/.exec(PEDIDO);
  assert(ct, 'compartilharTexto sumiu');
  assert(/navigator\.share/.test(ct[0]), 'não usa a Web Share API');
  assert(/AbortError/.test(ct[0]) && /'cancelado'/.test(ct[0]),
    'fechar a folha seria tratado como falha, e o sistema insistiria em abrir o WhatsApp');
});

t('C1c. falhar no envio NAO deixa o ERP em tela vazia', () => {
  const fn = /function abrirWhatsApp\([^)]*\)\{[\s\S]*?\n\}/.exec(PEDIDO)[0];
  assert(/mostrarMensagemParaCopiar/.test(fn),
    'quando nada abre, o usuário fica sem mensagem, sem link e sem explicação');
  const mc = /function mostrarMensagemParaCopiar\([^)]*\)\{[\s\S]*?\n\}/.exec(PEDIDO);
  assert(mc, 'mostrarMensagemParaCopiar sumiu');
  assert(/modalMsgWhats/.test(mc[0]), 'não abre o painel com a mensagem');
  assert(/msgWhatsTexto/.test(PEDIDO) && /copiarMsgWhats/.test(PEDIDO),
    'não dá para copiar a mensagem quando o envio falha');
  // O botão de última tentativa também não pode navegar o iframe.
  assert(!/(^|[^.\w])location\.href = url/m.test(mc[0]),
    'o botão "Abrir WhatsApp" navega o iframe — a tela vazia voltaria por aqui');
});

t('C2. a mensagem identifica a empresa emitente', () => {
  // `window.EMITENTE_NOME` era lido mas ninguém o preenchia: a mensagem saía
  // sem dizer de que empresa era o orçamento.
  assert(/emitente: emitenteNome/.test(ROTAS), 'a rota do link não devolve o emitente');
  assert(/window\.EMITENTE_NOME = d\.emitente/.test(PEDIDO), 'a tela não guarda o emitente');
  const fn = /async function enviarWhatsApp\([^)]*\)\{[\s\S]*?\n\}/.exec(PEDIDO)[0];
  assert(/EMITENTE_NOME/.test(fn), 'a mensagem perdeu o nome da empresa');
  assert(/obterLinkPublico/.test(fn), 'a mensagem deixou de usar o link público');
  assert(!/\/api\/pedidos\//.test(fn), 'a mensagem passou a levar rota interna autenticada');
});

t('C3. o PDF usa a folha nativa antes de tentar download', () => {
  const fn = /async function entregarPdf[\s\S]*?\n\}/.exec(PEDIDO);
  assert(fn, 'entregarPdf sumiu');
  assert(/navigator\.share/.test(fn[0]), 'não usa compartilhamento nativo — no iPhone não há como salvar');
  assert(/AbortError/.test(fn[0]), 'cancelar a folha seria tratado como erro');
  assert(/a\.download = nome/.test(fn[0]), 'perdeu o download com nome amigável no computador');
  assert(/URL\.revokeObjectURL/.test(fn[0]), 'vaza object URL');
});

t('C4. nenhuma acao de documento fica sem tratamento de erro', () => {
  for (const nome of ['entregarPdf', 'enviarWhatsApp', 'gerenciarLinkPublico',
                      'regerarLinkPublico', 'revogarLinkPublico']) {
    const fn = new RegExp(`async function ${nome}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(PEDIDO);
    assert(fn, `${nome} sumiu`);
    assert(/catch/.test(fn[0]) && /mensagemDeRede/.test(fn[0]),
      `${nome} não traduz a falha — o usuário veria "Load failed"`);
  }
});

t('C5. revogar e regerar pedem confirmacao', () => {
  for (const nome of ['regerarLinkPublico', 'revogarLinkPublico']) {
    const fn = new RegExp(`async function ${nome}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(PEDIDO)[0];
    assert(/confirm\(/.test(fn), `${nome} age sem confirmar — um toque errado derruba o link do cliente`);
  }
  assert(!/prompt\(\s*\n?\s*'Link público/.test(PEDIDO),
    'o painel do link voltou a ser um prompt em que se digita "REVOGAR"');
});

// ============================================================================
// D. Abas e campos no celular
// ============================================================================

t('D1. a faixa de abas indica que continua', () => {
  assert(/--tabs-fade-dir/.test(PEDIDO), 'não há indicação de continuidade na faixa de abas');
  assert(/function atualizarFadeAbas/.test(PEDIDO), 'o indicador não acompanha a rolagem');
  assert(/function revelarAbaAtiva/.test(PEDIDO), 'a aba ativa pode ficar fora da tela');
  assert(/scrollIntoView/.test(PEDIDO), 'a aba ativa não é trazida para a área visível');
  const ativar = /async function ativarAba\([\s\S]*?\n\}/.exec(PEDIDO)[0];
  assert(/revelarAbaAtiva/.test(ativar), 'trocar de aba não revela a aba escolhida');
});

t('D2. a descricao do item cabe inteira', () => {
  assert(!/<input type="text" id="itDesc">/.test(PEDIDO),
    'a descrição voltou a ser input de uma linha — nome longo fica cortado');
  assert(/<textarea id="itDesc"/.test(PEDIDO), 'o campo de descrição não é textarea');
  assert(/function ajustarAltura/.test(PEDIDO), 'o campo não cresce com o texto');
  assert(/ajustarAltura\(campo\)/.test(PEDIDO),
    'escolher um produto não reajusta a altura — o nome entraria escondido');
});

t('D2b. a descricao NA TABELA de itens nao e cortada', () => {
  // O relato depois do teste real: no formulário a descrição já cabia, mas na
  // tabela ela saía "MEIO TEMPERO COMPLET…". A causa era um <input> de 170px —
  // input é uma linha só, e nenhum `white-space` o faz quebrar.
  assert(!/salvarItemCampo\(\$\{it\.id\},'descricao'[\s\S]{0,60}type="text"/.test(PEDIDO),
    'a descrição do item voltou a ser input de uma linha');
  // Há duas células de descrição: a do documento travado (texto puro, que já
  // quebra sozinho) e a editável. É a editável que tinha o input.
  const celulas = [...PEDIDO.matchAll(/<td class="col-descricao" data-rot="Descrição">([\s\S]*?)<\/td>/g)]
    .map((m) => m[1]);
  assert(celulas.length >= 2, 'as células de descrição perderam o rótulo ou mudaram de forma');
  const editavel = celulas.find((c) => /salvarItemCampo/.test(c));
  assert(editavel, 'a célula editável de descrição sumiu');
  assert(/<textarea/.test(editavel), 'a descrição na tabela não é textarea — cortaria de novo');
  assert(/ajustarAltura\(this\)/.test(editavel), 'o campo não cresce com o texto');
  assert(/querySelectorAll\('textarea\.desc-item'\)\.forEach\(ajustarAltura\)/.test(PEDIDO),
    'os campos não são ajustados ao montar a tabela — nasceriam com uma linha só');
});

t('D2c. no celular a tabela de itens vira cards, sem nowrap nem ellipsis', () => {
  const media = /@media \(max-width: 640px\) \{[\s\S]*?\n  \}/.exec(PEDIDO)[0];
  assert(/\.tabela-itens[\s\S]*?display: block/.test(media),
    'a tabela de itens não vira cards no celular — 9 colunas não cabem em 320px');
  assert(/white-space: normal !important/.test(media),
    'a célula mantém nowrap: a descrição continuaria numa linha só');
  assert(/data-rot/.test(PEDIDO), 'as células não têm rótulo — no card o valor ficaria sem contexto');
  assert(/\.tabela-itens td\.col-descricao textarea[\s\S]*?font-size: 16px/.test(media),
    'a descrição da tabela fica abaixo de 16px no celular');
  // Nada de cortar texto na descrição, em lugar nenhum da tela.
  const cortes = [...PEDIDO.matchAll(/col-descricao[^{]*\{[^}]*\}/g)]
    .filter((m) => /ellipsis|text-overflow|white-space:\s*nowrap/.test(m[0]));
  assert(cortes.length === 0, 'há regra de corte na descrição: ' + cortes.map((c) => c[0]).join(' | '));
});

t('D3. os campos do celular tem 16px e alvo de toque', () => {
  // Abaixo de 16px o Safari do iOS dá zoom ao focar, e o formulário sai da tela.
  const media = /@media \(max-width: 640px\) \{[\s\S]*?\n  \}/.exec(PEDIDO);
  assert(media, 'a tela do pedido perdeu o bloco responsivo');
  assert(/font-size: 16px/.test(media[0]), 'campo abaixo de 16px no celular');
  assert(/min-height: 44px/.test(media[0]), 'botão sem alvo de toque confortável');
  assert(/\.ped-actions \{ display: grid/.test(media[0]),
    'os botões do cabeçalho não empilham — estourariam a largura em 320px');
});

t('D4. a correcao global de responsividade continua de pe', () => {
  const css = fs.readFileSync(path.join(PUB, 'css/app-modern.css'), 'utf8');
  assert(/overflow-x: hidden/.test(css), 'a trava de overflow horizontal global sumiu');
  assert(/\.tabela-rolagem/.test(css), 'o envelope de rolagem das tabelas sumiu');
});

// ============================================================================
// E. Ponta a ponta — orçamento salvo e NÃO convertido
// ============================================================================

const SCHEMA = path.join(TMP, 'schema.sql');
const ORIGEM = path.join(RAIZ, 'data/tenants/1bit/pncp.db');

function montarBanco() {
  const Database = require('better-sqlite3');
  if (!fs.existsSync(SCHEMA)) {
    // Leitura pura de um tenant real: o schema de verdade, não uma imitação que
    // passaria por cima de uma coluna faltando.
    fs.writeFileSync(SCHEMA, execFileSync('sqlite3', [`file:${ORIGEM}?mode=ro`, '.schema']).toString());
  }
  const arq = path.join(TMP, 'e2e.db');
  try { fs.unlinkSync(arq); } catch (_) {}
  const db = new Database(arq);
  db.exec(fs.readFileSync(SCHEMA, 'utf8').split(/;\s*\n/)
    .filter((s) => !/sqlite_sequence/i.test(s)).join(';\n'));
  return db;
}

/**
 * Chama um handler do Express direto, sem subir porta.
 *
 * O `res` é um `PassThrough` de verdade, e não um objeto com `write`/`end`
 * imitados: o PDFKit faz `doc.pipe(res)`, e `pipe` precisa de um Writable com
 * os eventos que o Node espera ('drain', 'error', 'finish'). Com o objeto
 * imitado o pipe não escrevia nada e o PDF saía vazio — o teste reprovaria um
 * gerador que funciona.
 */
function fazerChamador(app) {
  const { PassThrough } = require('stream');
  const achar = (p, m) => {
    const l = ((app.router || app._router).stack || [])
      .find((x) => x.route && x.route.path === p && x.route.methods[m]);
    if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
    return l.route.stack.at(-1).handle;
  };
  return function chamar(p, m, o = {}) {
    let corpo = null, st = 200;
    const cabecalhos = {};
    const res = new PassThrough();
    const pedacos = [];
    res.on('data', (b) => pedacos.push(b));
    res.json = (x) => { corpo = x; return res; };
    res.status = (c) => { st = c; return res; };
    res.send = (x) => { corpo = x; return res; };
    res.setHeader = (k, v) => { cabecalhos[k.toLowerCase()] = v; return res; };
    res.getHeader = (k) => cabecalhos[k.toLowerCase()];

    achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {},
                  session: o.session || {}, user: o.user, ip: '203.0.113.9', headers: {} }, res);

    // `doc.pipe(res)` só escreve nos ticks seguintes: ler o buffer agora daria
    // sempre vazio. Esperamos o fim do stream (ou o próximo tick, quando a rota
    // respondeu JSON e nenhum PDF vem).
    return new Promise((resolve) => {
      let pronto = false;
      const terminar = () => {
        if (pronto) return;
        pronto = true;
        resolve({ corpo, st, cabecalhos, pdf: pedacos.length ? Buffer.concat(pedacos) : null });
      };
      res.on('end', terminar);
      res.on('error', terminar);
      // Rota que respondeu JSON nunca fecha o stream: não podemos ficar presos.
      setTimeout(terminar, 4000).unref();
      setImmediate(() => { if (!pedacos.length && corpo !== null) terminar(); });
    });
  };
}

const DESC_LONGA = 'MEIO TEMPERO COMPLETO COM AÇAFRÃO - FARDO COM 24 UNIDADES DE 400G CADA';
const e2e = {};   // estado compartilhado entre os testes do bloco

t('E1. monta o cenario: orcamento salvo, 1 item, nao convertido', async () => {
  if (!fs.existsSync(ORIGEM)) throw new Error('tenant 1bit ausente — sem schema real para o E2E');
  const db = montarBanco();
  const express = require('express');
  const app = express();
  require('../pedidos-routes').registrarRotasPedidos(app, db);

  db.prepare(`INSERT INTO pessoas (id, cpfCnpj, tipo, razaoSocial, telefone, ativo)
              VALUES (1,'00000000000191','PJ','PARAISO COMERCIO DE ALIMENTOS LTDA','44999990000',1)`).run();
  db.prepare(`INSERT INTO fornecedor (id, razaoSocial, cnpj) VALUES (1,'EMITENTE TESTE LTDA','11222333000181')`).run();
  db.prepare(`INSERT INTO users (id, username, passwordHash, nome, role, ativo) VALUES (1,'admin','x','Admin','admin',1)`).run();

  const chamar = fazerChamador(app);
  const criado = await chamar('/api/pedidos', 'post', {
    body: { modoDocumento: 'orcamento', clienteId: 1, tipo: 'venda' },
    session: { userId: 1 }, user: { id: 1, role: 'admin' },
  });
  assert(criado.corpo && criado.corpo.success, 'não criou o orçamento: ' + JSON.stringify(criado.corpo));
  const id = criado.corpo.pedido.id;

  const item = await chamar('/api/pedidos/:id/itens', 'post', {
    params: { id: String(id) },
    body: { descricao: DESC_LONGA, quantidade: 1, precoUnitario: 42.5 },
    session: { userId: 1 }, user: { id: 1, role: 'admin' },
  });
  assert(item.corpo && item.corpo.success, 'não adicionou o item: ' + JSON.stringify(item.corpo));

  Object.assign(e2e, { db, chamar, id });
  const p = db.prepare('SELECT modoDocumento, numero, valorTotal FROM pedidos WHERE id = ?').get(id);
  assert(p.modoDocumento === 'orcamento', `nasceu como "${p.modoDocumento}", não como orçamento`);
  assert(/^ORC-\d{4}-\d{5}$/.test(p.numero), `numeração fora do padrão ORC-AAAA-NNNNN: ${p.numero}`);
  e2e.numero = p.numero;
});

t('E2. o PDF e gerado com o documento ainda como orcamento', async () => {
  const r = await e2e.chamar('/api/pedidos/:id/pdf', 'get', {
    params: { id: String(e2e.id) }, query: { download: '1' },
  });
  assert(r.pdf && r.pdf.length > 800, 'o PDF saiu vazio');
  assert(r.pdf.slice(0, 4).toString() === '%PDF', 'o que voltou não é um PDF');
  e2e.pdf = r.pdf;
  e2e.disposition = r.cabecalhos['content-disposition'] || '';
  assert((r.cabecalhos['content-type'] || '') === 'application/pdf', 'Content-Type errado');
});

t('E3. o arquivo se chama ORC-AAAA-NNNNN.pdf e forca o download', async () => {
  assert(e2e.disposition.startsWith('attachment'),
    '?download=1 não força o salvamento: ' + e2e.disposition);
  assert(e2e.disposition.includes(`filename="${e2e.numero}.pdf"`),
    'nome de arquivo diferente do número do documento: ' + e2e.disposition);
  // Sem `?download=1` continua abrindo no visualizador.
  const v = await e2e.chamar('/api/pedidos/:id/pdf', 'get', { params: { id: String(e2e.id) } });
  assert((v.cabecalhos['content-disposition'] || '').startsWith('inline'),
    'visualizar passou a baixar arquivo');
});

t('E4. a descricao completa esta no PDF', async () => {
  const arq = path.join(TMP, 'orc.pdf');
  fs.writeFileSync(arq, e2e.pdf);
  execFileSync('pdftotext', ['-layout', arq, arq.replace('.pdf', '.txt')]);
  const txt = fs.readFileSync(arq.replace('.pdf', '.txt'), 'utf8').replace(/\s+/g, ' ');
  // O fim da descrição é o que prova que não houve corte: `-layout` intercala
  // colunas, então buscar a frase inteira daria falso negativo.
  assert(txt.includes('MEIO TEMPERO COMPLETO COM AÇAFRÃO'), 'a descrição não chegou ao PDF');
  assert(/24 UNIDADES DE 400G CADA/.test(txt), 'a descrição foi truncada no PDF');
  assert(txt.includes(e2e.numero), 'o número do orçamento não aparece no PDF');
  assert(/ORÇAMENTO/.test(txt), 'o aviso de orçamento sumiu do PDF');
});

t('E5. o token publico e criado sob demanda, aleatorio e nao sequencial', async () => {
  const r = await e2e.chamar('/api/pedidos/:id/link-publico', 'post',
    { params: { id: String(e2e.id) }, body: {}, session: { userId: 1 }, user: { id: 1, role: 'admin' } });
  assert(r.corpo && r.corpo.success, 'não gerou o link: ' + JSON.stringify(r.corpo));
  const tk = r.corpo.token;
  e2e.token = tk;
  assert(/^[0-9a-f]{64}$/.test(tk), `token fora do formato esperado: ${tk}`);
  // Não é derivado do documento: nem o id nem o número aparecem nele, e dois
  // documentos não produzem tokens próximos.
  assert(tk !== String(e2e.id) && !tk.includes(e2e.numero.toLowerCase()),
    'o token é derivado do documento em vez de aleatório');
  assert(r.corpo.url.startsWith('/orcamento-comercial.html?token='), 'a URL pública mudou de forma');
  assert(r.corpo.emitente === 'EMITENTE TESTE LTDA', 'o emitente não veio junto — o WhatsApp sai sem empresa');

  // Chamar de novo devolve o MESMO: quem já recebeu o link não pode perdê-lo.
  const r2 = await e2e.chamar('/api/pedidos/:id/link-publico', 'post',
    { params: { id: String(e2e.id) }, body: {}, session: { userId: 1 }, user: { id: 1, role: 'admin' } });
  assert(r2.corpo.token === tk, 'gerar de novo trocou o token e invalidaria o link já enviado');
});

t('E6. o link publico abre sem sessao e mostra o necessario', async () => {
  const r = await e2e.chamar('/api/orcamento-publico/:token', 'get', { params: { token: e2e.token } });
  assert(r.st === 200 && r.corpo && r.corpo.success, 'a rota pública não abriu sem sessão');
  const o = r.corpo.orcamento || r.corpo.pedido || r.corpo;
  const txt = JSON.stringify(r.corpo);
  assert(txt.includes(e2e.numero), 'o recorte público não traz o número');
  assert(txt.includes('MEIO TEMPERO COMPLETO COM AÇAFRÃO'), 'o recorte público não traz o item');
  assert(txt.includes('EMITENTE TESTE LTDA'), 'o recorte público não identifica o emitente');
  void o;
});

t('E7. o PDF publico abre sem sessao', async () => {
  const r = await e2e.chamar('/api/orcamento-publico/:token/pdf', 'get', { params: { token: e2e.token } });
  assert(r.pdf && r.pdf.slice(0, 4).toString() === '%PDF', 'o PDF público não foi gerado');
  assert((r.cabecalhos['content-disposition'] || '').includes(e2e.numero),
    'o PDF público sai com nome diferente do documento');
});

t('E8. o recorte publico NAO expoe dado interno', async () => {
  const r = await e2e.chamar('/api/orcamento-publico/:token', 'get', { params: { token: e2e.token } });
  const txt = JSON.stringify(r.corpo);
  for (const proibido of ['custo', 'margem', 'precoCusto', 'vendedorId', 'userId',
                          'tokenPublico', 'clienteId', 'faturaId', 'compraId']) {
    assert(!new RegExp(proibido, 'i').test(txt),
      `a página pública expõe "${proibido}" — quem abre o link é o cliente`);
  }
});

t('E9. token invalido e token de outro formato falham em seguro', async () => {
  for (const ruim of ['naoexiste', '0'.repeat(64), '../../etc/passwd', '1', '%00']) {
    const r = await e2e.chamar('/api/orcamento-publico/:token', 'get', { params: { token: ruim } });
    assert(r.st === 404 || (r.corpo && r.corpo.success === false),
      `token inválido "${ruim}" não foi recusado (status ${r.st})`);
    assert(!JSON.stringify(r.corpo || '').includes(e2e.numero),
      `token inválido "${ruim}" vazou dados de um documento`);
  }
});

t('E10. nao da para enumerar orcamentos', async () => {
  // Sem o token não existe caminho público: trocar id na URL não leva a lugar
  // nenhum, porque a rota pública nem aceita id.
  const r = await e2e.chamar('/api/orcamento-publico/:token', 'get', { params: { token: String(e2e.id) } });
  assert(r.st === 404 || (r.corpo && r.corpo.success === false),
    'passar o id interno como token abriu o documento');
});

t('E11. o token revogado para de funcionar na hora', async () => {
  const d = await e2e.chamar('/api/pedidos/:id/link-publico', 'delete',
    { params: { id: String(e2e.id) }, session: { userId: 1 }, user: { id: 1, role: 'admin' } });
  assert(d.corpo && d.corpo.success, 'a revogação falhou');
  const r = await e2e.chamar('/api/orcamento-publico/:token', 'get', { params: { token: e2e.token } });
  assert(r.st === 404 || (r.corpo && r.corpo.success === false),
    'o link revogado continua abrindo o documento');
  const p = await e2e.chamar('/api/orcamento-publico/:token/pdf', 'get', { params: { token: e2e.token } });
  assert(!p.pdf || p.pdf.slice(0, 4).toString() !== '%PDF', 'o PDF do link revogado continua saindo');
});

t('E12. da para gerar um link novo depois de revogar', async () => {
  const r = await e2e.chamar('/api/pedidos/:id/link-publico', 'post',
    { params: { id: String(e2e.id) }, body: {}, session: { userId: 1 }, user: { id: 1, role: 'admin' } });
  assert(r.corpo && r.corpo.success, 'não gerou link novo após a revogação');
  assert(r.corpo.token !== e2e.token, 'o link novo é igual ao revogado');
  const novo = r.corpo.token;
  assert((await e2e.chamar('/api/orcamento-publico/:token', 'get', { params: { token: novo } })).st === 200,
    'o link novo não abre');
  // E o antigo continua morto.
  const velho = await e2e.chamar('/api/orcamento-publico/:token', 'get', { params: { token: e2e.token } });
  assert(velho.st === 404 || (velho.corpo && velho.corpo.success === false),
    'o link antigo ressuscitou quando o novo foi criado');
  e2e.tokenNovo = novo;
});

t('E13. regerar troca o token e derruba o anterior', async () => {
  const r = await e2e.chamar('/api/pedidos/:id/link-publico', 'post', {
    params: { id: String(e2e.id) }, body: { regerar: 'true' },
    session: { userId: 1 }, user: { id: 1, role: 'admin' },
  });
  assert(r.corpo.token !== e2e.tokenNovo, 'regerar devolveu o mesmo token');
  const velho = await e2e.chamar('/api/orcamento-publico/:token', 'get', { params: { token: e2e.tokenNovo } });
  assert(velho.st === 404 || (velho.corpo && velho.corpo.success === false),
    'regerar não derrubou o link anterior');
});

t('E14. NADA disso converteu, faturou, ou mexeu em estoque e financeiro', async () => {
  const db = e2e.db;
  const p = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(e2e.id);

  // O ponto central do pedido: o documento continua sendo um orçamento.
  assert(p.modoDocumento === 'orcamento',
    `o documento virou "${p.modoDocumento}" — algo o converteu pelo caminho`);
  assert(p.numero === e2e.numero, `o número mudou de ${e2e.numero} para ${p.numero}`);
  assert(!p.faturaId, 'o orçamento ganhou fatura');
  assert(p.status === 'rascunho', `o status mudou para "${p.status}"`);

  const vazia = (tab, onde = '1=1') => {
    try { return db.prepare(`SELECT COUNT(*) n FROM ${tab} WHERE ${onde}`).get().n === 0; }
    catch (_) { return true; }   // instalação sem a tabela: nada a provar
  };
  assert(vazia('faturas'), 'gerou fatura');
  assert(vazia('estoque_movimentos'), 'movimentou estoque');
  assert(vazia('reservas_estoque'), 'reservou estoque');
  assert(vazia('contas_a_receber'), 'gerou conta a receber');
  assert(vazia('notas_fiscais'), 'gerou nota fiscal');
  assert(vazia('nfe_emitidas'), 'gerou NF-e');
  assert(vazia('nfce_emitidas'), 'gerou NFC-e');
});

t('E15. orcamento GRANDE (42 itens) nao regride a paginacao do PDF', async () => {
  // A rodada anterior corrigiu altura medida, quebra de página, cabeçalho
  // repetido e rodapé. Um orçamento de um item não exercita nada disso.
  const { db, chamar, id } = e2e;
  const longas = [
    'MOLHO DE PIMENTA ARTESANAL EXTRA FORTE COM ALHO E ERVAS FINAS SELECIONADAS FARDO 12UN',
    'TEMPERO COMPLETO COM AÇAFRÃO - FARDO COM 24 UNIDADES DE 400G CADA',
    'SAL', 'BICARBONATO DE SÓDIO - FD 20 UN 40G',
  ];
  for (let i = 0; i < 41; i++) {
    await chamar('/api/pedidos/:id/itens', 'post', {
      params: { id: String(id) },
      body: { descricao: `${longas[i % longas.length]} [${i + 2}]`, quantidade: (i % 7) + 1, precoUnitario: 18.9 },
      session: { userId: 1 }, user: { id: 1, role: 'admin' },
    });
  }
  const n = db.prepare('SELECT COUNT(*) n FROM pedido_itens WHERE pedidoId = ?').get(id).n;
  assert(n === 42, `esperava 42 itens, tem ${n}`);

  const r = await chamar('/api/pedidos/:id/pdf', 'get', { params: { id: String(id) } });
  const arq = path.join(TMP, 'grande.pdf');
  fs.writeFileSync(arq, r.pdf);
  const paginas = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [arq]).toString())[1]);
  assert(paginas >= 2, `42 itens couberam em ${paginas} página — algo os comprimiu`);

  execFileSync('pdftotext', ['-layout', arq, arq.replace('.pdf', '.txt')]);
  const txt = fs.readFileSync(arq.replace('.pdf', '.txt'), 'utf8');
  // Nenhum item some na quebra de página: os 42 têm de estar lá.
  for (let i = 2; i <= 42; i++) {
    assert(txt.includes(`[${i}]`), `o item ${i} sumiu do PDF — perdido na quebra de página`);
  }
  // O rodapé e o número aparecem em TODAS as páginas.
  const conta = (s) => (txt.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  assert(conta('SEM VALOR FISCAL') === paginas,
    `o aviso está em ${conta('SEM VALOR FISCAL')} de ${paginas} páginas`);
  // O cabeçalho da TABELA repete: sem ele, as linhas da página 2 ficariam sem
  // dizer qual coluna é quantidade e qual é valor.
  assert(conta('V.Unit') >= paginas,
    `o cabeçalho da tabela está em ${conta('V.Unit')} de ${paginas} páginas`);
  // O total vem DEPOIS dos itens, não no meio.
  assert(txt.lastIndexOf('[42]') < txt.lastIndexOf('TOTAL') || /TOTAL/.test(txt.split('[42]').pop()),
    'o total aparece antes do último item');
});

// ============================================================================
// F. A porta pública continua sendo só uma porta
// ============================================================================

t('F1. so a rota publica esta liberada; /api/pedidos continua fechado', () => {
  const auth = fs.readFileSync(path.join(RAIZ, 'auth.js'), 'utf8');
  // Comentários fora: eles CITAM `/api/pedidos/*` ao explicar que ele continua
  // protegido, e a busca casaria com a própria explicação.
  //
  // Linha ANTES de bloco, nesta ordem. Ao contrário, um comentário de linha que
  // termina em `/api/orcamento/:token/*)` abre um falso `/*` e o strip engole
  // 15 linhas de código real — inclusive o bypass que este teste procura, que
  // então "sumia" e reprovava um auth.js correto.
  const semCom = auth.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  const liberados = [...semCom.matchAll(/req\.path\.startsWith\('([^']+)'\)\)\s*return next\(\)/g)]
    .map((m) => m[1]);
  assert(liberados.includes('/api/orcamento-publico/'),
    'a rota pública saiu do bypass — o cliente cairia na tela de login');
  const perigosos = liberados.filter((p) => /^\/api\/pedidos/.test(p));
  assert(perigosos.length === 0,
    'o painel foi aberto junto com o compartilhamento: ' + perigosos.join(', '));
});

t('F2. a pagina publica nao edita, nao converte e nao chama API interna', () => {
  assert(!/\/api\/pedidos\//.test(PUBLICA), 'a página pública chama a API interna do ERP');
  for (const proibido of ['converter', 'faturar', 'salvarItem', 'method: *[\'"]POST',
                          'method: *[\'"]PUT', 'method: *[\'"]DELETE']) {
    assert(!new RegExp(proibido, 'i').test(PUBLICA),
      `a página pública tem caminho de escrita ("${proibido}")`);
  }
  assert(!/<input(?![^>]*type="?hidden)/i.test(PUBLICA) || !/onchange|oninput/i.test(PUBLICA),
    'a página pública tem campo editável');
});

t('F3. o token nao viaja em log nem em URL de terceiro', () => {
  const rotaPub = /app\.get\('\/api\/orcamento-publico\/:token'[\s\S]*?\n  \}\);/.exec(ROTAS);
  assert(rotaPub, 'a rota pública sumiu');
  assert(!/console\.log\([^)]*token/i.test(rotaPub[0]), 'o token vai parar no log');
});

(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
