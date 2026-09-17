/**
 * Fase 3.5 — "Venda rápida": navegação entre Pedidos e a tela de balcão.
 *
 * A fase foi só de navegação e rótulo. O que pode dar errado aqui não é regra
 * de negócio — é oferecer ao usuário uma porta que ele não consegue abrir, ou
 * deixar a tela sem caminho de volta.
 *
 * O teste mais importante é o D1: ele PROVA, rodando o RBAC de verdade, que o
 * botão só aparece para quem a permissão alcança. Sem ele, a checagem seria a
 * minha palavra de que `getAcessoCache` foi consultado.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const LISTA = fs.readFileSync(path.join(PUB, 'comercial/pedidos.html'), 'utf8');
const LISTA_L = semComentarios(LISTA);
const PDV = fs.readFileSync(path.join(PUB, 'comercial/pedidos-pdv.html'), 'utf8');
const PDV_L = semComentarios(PDV);
const MENU = fs.readFileSync(path.join(PUB, 'js/menu-config.js'), 'utf8');

// ============================================================================
// A. As duas portas existem na listagem
// ============================================================================

t('A1. a listagem oferece "Novo pedido" e "Venda rapida"', () => {
  assert(/onclick="criarPedidoVazio\(\)"[^>]*>\+ Novo pedido</.test(LISTA_L),
    'o botão "+ Novo pedido" sumiu da listagem');
  assert(/id="btnVendaRapida"/.test(LISTA_L), 'o botão "Venda rápida" não existe');
  assert(/Venda rápida<\/a>/.test(LISTA_L), 'o rótulo "Venda rápida" sumiu');
});

t('A2. a Venda rapida aponta para a tela que ja existe', () => {
  const tag = /<a[^>]*id="btnVendaRapida"[^>]*>/.exec(LISTA_L);
  assert(tag, 'tag do botão não encontrada');
  assert(/href="\/comercial\/pedidos-pdv\.html"/.test(tag[0]),
    'o botão aponta para outro lugar — a fase não criou tela nova');
});

t('A3. nenhuma rota ou endpoint novo foi criado', () => {
  // A fase é de navegação. Se aparecer /api/venda-rapida, algo saiu do escopo.
  for (const arq of [LISTA_L, PDV_L]) {
    assert(!/\/api\/venda-rapida/.test(arq), 'apareceu um endpoint /api/venda-rapida');
  }
  const rotas = fs.readFileSync(path.join(RAIZ, 'route-registry.js'), 'utf8');
  assert(!/venda-rapida/.test(rotas), 'venda-rapida foi registrada como rota');
});

// ============================================================================
// B. A tela de balcão se apresenta como Venda rápida
// ============================================================================

t('B1. titulo e <title> dizem "Venda rapida"', () => {
  assert(/<title>Venda rápida · Licite Agora<\/title>/.test(PDV), '<title> não mudou');
  assert(/<h1>Venda rápida<\/h1>/.test(PDV_L), 'o h1 não diz "Venda rápida"');
  assert(!/<h1>Pedidos PDV<\/h1>/.test(PDV_L), 'o h1 antigo continua lá');
});

t('B2. tem subtitulo, e ele nao rouba espaco do balcao', () => {
  assert(/Crie pedidos de forma simples e rápida no balcão, celular ou tablet\./.test(PDV_L),
    'o subtítulo sumiu');
  // Abaixo de 1100px o cabeçalho já divide a linha com 3 modos e 2 botões.
  assert(/\.pdv-titulo small \{[^}]*display: none/.test(PDV_L),
    'o subtítulo nasce visível — empurraria a grade de produtos para baixo no tablet');
  assert(/@media \(min-width: 1100px\) \{ \.pdv-titulo small \{ display: block; \} \}/.test(PDV_L),
    'o subtítulo nunca aparece: a regra que o mostra no desktop sumiu');
});

t('B3. ha caminho de volta para Pedidos', () => {
  const volta = /<a class="pdv-voltar"[^>]*>/.exec(PDV_L);
  assert(volta, 'o link de retorno não existe');
  assert(/href="\/comercial\/pedidos\.html"/.test(volta[0]), 'o retorno não aponta para Pedidos');
  assert(/aria-label="Voltar para Pedidos"/.test(volta[0]), 'o retorno não tem nome acessível');
  assert(/\.pdv-voltar \{[^}]*width: 36px/.test(PDV_L), 'o alvo de toque do retorno encolheu');
});

// ============================================================================
// C. O menu: rótulo novo, chave intacta
// ============================================================================

t('C1. o menu mostra "Venda rapida" e mantem a chave pedidos-pdv', () => {
  const item = /\{ page: 'pedidos-pdv'[^}]*\}/.exec(MENU);
  assert(item, 'o item do menu sumiu');
  assert(/texto: 'Venda rápida'/.test(item[0]), 'o rótulo do menu não mudou');
  assert(/page: 'pedidos-pdv'/.test(item[0]),
    'a CHAVE mudou — ela está gravada em perfis_acesso.paginas nos tenants');
  assert(/link: '\/comercial\/pedidos-pdv\.html'/.test(item[0]),
    'o link mudou — arquivos não foram renomeados nesta fase');
});

t('C2. o menu nao mudou de tamanho', () => {
  const { menuConfig } = require(path.join(PUB, 'js/menu-config.js'));
  const n = menuConfig.secoes.reduce((a, s) => a + s.itens.length, 0);
  // Piso, não igualdade: o total sobe quando uma tela legítima é acrescentada
  // (Categorias entrou na Fase 44). O risco que este teste cobre é PERDER um
  // item — a chave do menu está gravada em `perfis_acesso.paginas` nos tenants,
  // e removê-la tira o acesso de quem já a tinha.
  assert(n >= 190, `o menu perdeu itens: ${n} (piso 190) — esta fase só renomeia`);
});

// ============================================================================
// D. O botão respeita o RBAC — o teste que importa
// ============================================================================

t('D1. o botao so aparece para quem a permissao alcanca', () => {
  // Executa a função real extraída da tela, contra os três estados possíveis
  // de acesso. Não é leitura de código: o comportamento é exercido.
  const fonte = /\(function mostrarVendaRapida\(\)\{[\s\S]*?\}\)\(\);/.exec(LISTA);
  assert(fonte, 'mostrarVendaRapida não encontrada na listagem');

  const casos = [
    ['irrestrito (admin)', { irrestrito: true, paginas: [] }, true],
    ['perfil COM pedidos-pdv', { irrestrito: false, paginas: ['pedidos', 'pedidos-pdv'] }, true],
    ['perfil SEM pedidos-pdv', { irrestrito: false, paginas: ['pedidos'] }, false],
    ['sem cache ainda', null, false],
  ];

  for (const [nome, acesso, esperado] of casos) {
    const btn = { hidden: true };
    const ctx = {
      document: { getElementById: (id) => (id === 'btnVendaRapida' ? btn : null) },
      getAcessoCache: () => acesso,
      console: { warn() {}, error() {} },
    };
    vm.createContext(ctx);
    new vm.Script(fonte[0]).runInContext(ctx);
    assert(btn.hidden === !esperado,
      `${nome}: botão ${btn.hidden ? 'oculto' : 'visível'}, esperado ${esperado ? 'visível' : 'oculto'}`);
  }
});

t('D2. o botao nasce oculto no HTML', () => {
  const tag = /<a[^>]*id="btnVendaRapida"[^>]*>/.exec(LISTA_L);
  assert(/\shidden\b/.test(tag[0]),
    'o botão nasce visível — apareceria por um instante para quem não pode, antes do JS rodar');
});

t('D3. a decisao usa o MESMO cache da sidebar, sem chamada nova', () => {
  const fonte = /\(function mostrarVendaRapida\(\)\{[\s\S]*?\}\)\(\);/.exec(LISTA)[0];
  assert(/getAcessoCache/.test(fonte), 'não usa o cache de acesso da sidebar');
  assert(!/fetch\(/.test(fonte), 'a função faz requisição própria — o cache já existe');
});

t('D4. a tela em si continua protegida pelo servidor', () => {
  // O botão é apresentação. Quem barra de verdade é o RBAC, e ele depende de a
  // página seguir REGISTRADA no menu (checagem nominal em `podeVerPath`).
  const item = /\{ page: 'pedidos-pdv'[^}]*\}/.exec(MENU);
  assert(item, 'a página saiu do menu — cairia no fallback por diretório e '
    + 'qualquer perfil com uma página de /comercial/ abriria o balcão (ver test-pdv-rbac B3)');
});

// ============================================================================
// E. Nada do que existia foi perdido
// ============================================================================

t('E1. a Venda rapida preserva tudo o que a Fase 2.x construiu', () => {
  const obrigatorios = [
    ['abrirNovoCliente', 'cadastro rápido de cliente'],
    ['pintarCategorias', 'categorias'],
    ['card-prod', 'cards de produto'],
    ['aplicarDesconto', 'desconto com alçada'],
    ['tipoAtendimento', 'tipo de atendimento'],
    ['no_local', 'No local'],
    ['retirada', 'Retirada'],
    ['entrega', 'Entrega'],
    ['abrirPendentes', 'pedidos pendentes'],
    ['function retomar', 'retomar pedido'],
    ['pointer: coarse', 'toque'],
  ];
  for (const [marca, nome] of obrigatorios) {
    assert(PDV.includes(marca), `${nome} sumiu da Venda rápida`);
  }
});

t('E2. a listagem nao perdeu nada', () => {
  for (const marca of ['criarPedidoVazio', 'criarOrcamentoVazio', 'abrirModalImport', 'aplicarAcaoMassa']) {
    assert(LISTA.includes(marca), `a listagem perdeu ${marca}`);
  }
});

t('E3. os dois fluxos continuam na MESMA listagem', () => {
  // Um pedido da Venda rápida e um do fluxo tradicional são o mesmo registro.
  // Se a listagem passasse a filtrar por tipo, deixariam de conviver.
  assert(!/tipo\s*=\s*['"]manual['"]/.test(LISTA_L),
    'a listagem passou a filtrar por tipo — pedidos da Venda rápida sumiriam dela');
  assert(/\/api\/pedidos/.test(LISTA), 'a listagem deixou de ler /api/pedidos');
});

(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
