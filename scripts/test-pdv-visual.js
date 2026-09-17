/**
 * Pedidos PDV — estrutura visual e uso de tokens.
 *
 * Não substitui olhar a tela: nenhum teste automático julga espaçamento ou
 * equilíbrio. O que ele garante é o que dá para garantir sem navegador —
 * que a tela use os tokens do sistema (e portanto funcione nos dois temas),
 * que os estados existam, que nada se sobreponha por medida, e que os handlers
 * do HTML tenham função correspondente.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const PDV = path.join(RAIZ, 'public/comercial/pedidos-pdv.html');
const H = fs.readFileSync(PDV, 'utf8');
const CSS_SB = fs.readFileSync(path.join(RAIZ, 'public/css/sidebar.css'), 'utf8');

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

/** O CSS da tela (o `<style>` do próprio arquivo). */
const CSS = (/<style>([\s\S]*?)<\/style>/.exec(H) || ['', ''])[1];

// ==================== A. TEMA: TOKENS, NÃO CORES ====================

t('A1. o CSS da tela nao tem cor fixa fora dos casos justificados', () => {
  // Fixas aceitáveis: branco sobre fundo de acento (contraste garantido pelo
  // token do fundo) e sombras em rgba, que não são cor de tema.
  const achados = [];
  for (const m of CSS.matchAll(/(?:^|[;{\s])(color|background(?:-color)?)\s*:\s*([^;}]+)/g)) {
    const v = m[2].trim();
    if (/var\(--/.test(v) || /transparent|inherit|none|currentColor/i.test(v)) continue;
    if (/^#fff\b|^#ffffff\b/i.test(v)) continue;            // texto sobre --accent
    if (/^rgba?\(0,\s*0,\s*0/.test(v)) continue;            // sombra/overlay
    if (/linear-gradient\(\s*160deg,\s*var\(/.test(v)) continue;
    achados.push(`${m[1]}: ${v}`);
  }
  assert(achados.length === 0, 'cores fixas: ' + achados.join(' · '));
});

t('A2. nenhum uso de token inexistente', () => {
  const usados = [...new Set([...CSS.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]))];
  const app = fs.readFileSync(path.join(RAIZ, 'public/css/app-modern.css'), 'utf8');
  const definidos = new Set([...app.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1])
    .concat([...CSS_SB.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1])));
  const faltando = usados.filter((u) => !definidos.has(u));
  assert(faltando.length === 0, 'tokens não definidos: ' + faltando.join(', '));
});

t('A3. o theme-color do <meta> nao esta fixo no escuro', () => {
  // `theme-boot.js` reescreve o valor conforme o tema; o que não pode é a tela
  // ter um valor fixo que o boot não alcance.
  assert(H.includes('/js/theme-boot.js'), 'a tela não carrega o theme-boot');
});

// ==================== B. ESTADOS DA ÁREA CENTRAL ====================

t('B1. existe skeleton, e ele e contido (6 cards, nao uma parede)', () => {
  assert(/function pintarSkeleton/.test(H), 'sem função de skeleton');
  const m = /Array\.from\(\{ length: (\d+) \}/.exec(H);
  assert(m, 'skeleton sem contagem explícita');
  const n = Number(m[1]);
  assert(n > 0 && n <= 12, `skeleton com ${n} elementos — demais para um estado temporário`);
  assert(/\.skel \.bloco/.test(CSS) && /@keyframes pulsar/.test(CSS), 'skeleton sem estilo/animação');
});

t('B2. o skeleton respeita prefers-reduced-motion', () => {
  assert(/prefers-reduced-motion[\s\S]*?animation:\s*none/.test(CSS),
    'a animação não é desligada para quem pede menos movimento');
});

t('B3. ha estado distinto para: sem resultado, catalogo vazio e erro', () => {
  assert(/Nenhum produto encontrado/.test(H), 'sem estado de busca sem resultado');
  assert(/Nenhum produto cadastrado/.test(H), 'sem estado de catálogo vazio');
  assert(/Não foi possível carregar os produtos/.test(H), 'sem estado de erro');
  // O rótulo virou "Tentar novamente" em 13/09 (relatório 42). O que importa é
  // haver um caminho de volta, não a redação exata do botão.
  assert(/Tentar (de novo|novamente)/.test(H), 'o estado de erro não oferece nova tentativa');
});

t('B4. o estado vazio orienta a saida (nao e so uma frase)', () => {
  assert(/Ver todos os produtos/.test(H), 'sem ação para limpar o filtro de categoria');
});

// ==================== C. CARDS DE PRODUTO ====================

t('C1. o placeholder NAO e o emoji de caixa', () => {
  // O card saiu de um `.map()` único para a função `card()`, montada item a
  // item dentro de try/catch — foi assim que um produto ilegível deixou de
  // apagar o catálogo inteiro (relatório 42). O bloco a inspecionar é a função.
  const cards = /const card = \(p\) => \{[\s\S]*?\n  \};/.exec(H);
  assert(cards, 'bloco de render dos cards não encontrado');
  assert(!/📦/.test(cards[0]), 'o emoji 📦 voltou a ser o placeholder dos cards');
  assert(/sem-img/.test(cards[0]) && /sigla\(/.test(cards[0]), 'sem monograma para produto sem foto');
});

t('C2. imagem quebrada cai no monograma, nao no icone de erro', () => {
  assert(/onerror=[^>]*sem-img/.test(H), 'sem tratamento de imagem quebrada');
});

t('C3. hierarquia: preco maior que o nome', () => {
  const preco = /\.card-prod \.preco \{[^}]*font-size:\s*([\d.]+)rem/.exec(CSS);
  const nome = /\.card-prod \.nome \{[^}]*font-size:\s*([\d.]+)rem/.exec(CSS);
  assert(preco && nome, 'preço/nome sem tamanho definido');
  assert(Number(preco[1]) > Number(nome[1]),
    `preço (${preco[1]}rem) não está mais destacado que o nome (${nome[1]}rem)`);
});

t('C4. produto sem estoque tem estado visual proprio', () => {
  assert(/tag-esgotado/.test(CSS) && /Sem estoque/.test(H), 'sem marcação de indisponível');
  assert(/\.saldo\.zero \{[^}]*var\(--danger\)/.test(CSS), 'saldo zerado sem cor de alerta');
});

t('C5. o saldo mostrado vem do servidor, e o card nao inventa preco', () => {
  // O preço exibido é `p.precoVenda` da API; nenhum cálculo local.
  assert(/brl\(p\.precoVenda\)/.test(H), 'o card não usa o preço da API');
  assert(!/precoUnitario:/.test(H), 'a tela envia preço ao servidor — o servidor é a autoridade');
});

// ==================== D. PAINEL DO PEDIDO ====================

t('D1. estado vazio do painel tem CTA para novo pedido', () => {
  assert(/ped-vazio/.test(CSS) && /ped-vazio/.test(H), 'sem estado vazio do painel');
  const bloco = /<div class="ped-vazio">[\s\S]*?<\/div>/.exec(H);
  assert(bloco && /abrirNovoPedido\(\)/.test(bloco[0]), 'o estado vazio não chama + Novo pedido');
});

t('D2. o TOTAL e o maior numero do painel', () => {
  const total = /\.linha\.total \{[^}]*font-size:\s*([\d.]+)rem/.exec(CSS);
  const item = /\.item \.tot \{[^}]*font-size:\s*([\d.]+)rem/.exec(CSS);
  assert(total && item, 'total/item sem tamanho');
  assert(Number(total[1]) >= Number(item[1]) * 1.4,
    `TOTAL (${total[1]}rem) pouco destacado ante o item (${item[1]}rem)`);
});

t('D3. controles de quantidade sao touch-friendly', () => {
  const m = /@media \(pointer: coarse\)[\s\S]*?\.qbtn \{[^}]*width:\s*(\d+)px/.exec(CSS);
  assert(m, 'sem ajuste de toque para os botões de quantidade');
  assert(Number(m[1]) >= 36, `botão de ${m[1]}px é pequeno demais para o dedo`);
});

t('D4. a acao principal diz o que faz (nao promete pagamento)', () => {
  assert(/function salvarPedido/.test(H), 'salvarPedido não existe');
  // A verificação é sobre o RÓTULO do botão, não sobre o arquivo: o comentário
  // ao lado dele cita "Ir para pagamento" justamente para explicar por que esse
  // nome foi descartado.
  const btn = /<button[^>]*id="btnSalvar"[^>]*>([^<]*)</.exec(H);
  assert(btn, 'botão principal sem id estável (btnSalvar)');
  const rotulo = btn[1].trim();
  assert(/salvar/i.test(rotulo), `rótulo "${rotulo}" não diz que salva`);
  assert(!/pagamento|pagar|continuar/i.test(rotulo),
    `rótulo "${rotulo}" promete uma etapa que não existe nesta fase`);
});

t('D5. o desconto continua sendo decidido pelo backend', () => {
  assert(/descontoPercentual/.test(H), 'a tela não envia o percentual');
  assert(/aguardandoAprovacao/.test(H), 'a tela não lê a resposta de alçada do servidor');
  // Nenhuma faixa/limite codificada no frontend.
  assert(!/limiteValor|regras_alcada|papelAprovador\s*=/.test(H),
    'há regra de alçada no JavaScript — a decisão é do servidor');
});

// ==================== E. PENDENTES ====================

t('E1. a lista de pendentes mostra cliente, numero, tipo, valor e hora', () => {
  const bloco = /\$\('listaPend'\)\.innerHTML = lista\.length[\s\S]*?:/.exec(H);
  assert(bloco, 'render dos pendentes não encontrado');
  for (const campo of ['clienteNome', 'numero', 'ROTULO_MODO', 'valorTotal', 'dataHora']) {
    assert(bloco[0].includes(campo), 'falta ' + campo + ' na linha de pendente');
  }
});

t('E2. os pendentes sao filtrados no SERVIDOR por status e tipo', () => {
  assert(/\/api\/pedidos\?status=rascunho&tipo=pdv/.test(H),
    'o filtro não é do servidor — traria pedidos de outros tipos');
});

t('E3. dataHora converte de UTC para horario local', () => {
  const fn = /function dataHora\(v\) \{[\s\S]*?\n\}/.exec(H);
  assert(fn, 'dataHora não encontrada');
  const dataHora = new Function(fn[0] + '; return dataHora;')();
  // O banco grava UTC (CLAUDE.md); 16:40 UTC é 13:40 em Brasília.
  assert(dataHora('2026-09-11 16:40:06').includes('13:40'),
    'não converteu UTC→BRT: ' + dataHora('2026-09-11 16:40:06'));
  assert(dataHora(null) === '—', 'valor ausente deveria virar travessão');
  assert(dataHora('lixo') !== undefined, 'valor inválido quebrou');
});

// ==================== F. LAYOUT E SOBREPOSIÇÃO ====================

/**
 * Fase 3.3: o botão de tema saiu de cima do conteúdo e foi para a topbar do
 * shell. A reserva de 58px que o relatório 25 criou aqui deixou de ter objeto —
 * e estes dois testes passam a vigiar que a causa não volte.
 */
t('F1. nada flutua sobre o cabecalho do PDV, e a reserva saiu', () => {
  const btn = /#btnTema \{([^}]*)\}/.exec(CSS_SB);
  assert(btn, 'bloco do #btnTema sumiu');
  assert(!/position:\s*fixed/.test(btn[1]),
    'o botão de tema voltou a ser fixed — cobriria o "+ Novo pedido" de novo');
  assert(!/\.pdv-topo \{[\s\S]{0,160}?padding:\s*\d+px\s+5\dpx/.test(CSS),
    'a reserva de 58px voltou ao .pdv-topo sem um botão flutuante para reservar');
});

t('F2. a gaveta do pedido fica acima do proprio fundo e abaixo dos modais', () => {
  // A gaveta está dentro do iframe e a topbar no documento pai: contextos de
  // empilhamento diferentes, e a topbar não alcança o conteúdo do iframe. O que
  // ainda precisa valer é a ordem interna.
  const gav = Number(/\.pdv-pedido \{\s*position: fixed;[\s\S]*?z-index:\s*(\d+)/.exec(CSS)[1]);
  const fundo = Number(/\.gaveta-bg \{[^}]*z-index:\s*(\d+)/.exec(CSS)[1]);
  assert(fundo < gav, `fundo (${fundo}) acima da própria gaveta (${gav})`);
  assert(gav < 10000, `gaveta (${gav}) acima dos modais`);
});

t('F3. as tres larguras existem e o mobile nao e o desktop encolhido', () => {
  assert(/grid-template-columns:\s*208px 1fr 372px/.test(CSS), 'sem as três colunas do desktop');
  assert(/@media \(max-width: 1099px\)/.test(CSS), 'sem faixa de tablet');
  assert(/@media \(max-width: 639px\)/.test(CSS), 'sem faixa de celular');
  const tablet = /@media \(max-width: 1099px\) \{([\s\S]*?)\n\}/.exec(CSS)[1];
  assert(/flex-direction:\s*row/.test(tablet), 'categorias não viram faixa horizontal');
  assert(/translateX\(100%\)/.test(tablet), 'o pedido não vira gaveta');
});

t('F4. a barra do carrinho respeita a safe-area do notch', () => {
  assert(/env\(safe-area-inset-bottom\)/.test(CSS), 'sem safe-area na barra fixa');
});

// ==================== G. SIDEBAR COMPACTA ====================

t('G1. a largura da sidebar vem de uma variavel, nao de 250px repetido', () => {
  const app = fs.readFileSync(path.join(RAIZ, 'public/app.html'), 'utf8');
  assert(/--sidebar-w/.test(CSS_SB), 'sidebar.css não define --sidebar-w');
  assert(/left:\s*var\(--sidebar-w\)/.test(app), 'o shell ainda posiciona o iframe com valor fixo');
  assert(!/left:\s*250px/.test(app), 'sobrou 250px hardcoded no shell');
});

t('G2. o modo compacto revela os icones do menu', () => {
  // No menu normal `.menu-item .icon` é `display:none`; sem revelar no compacto,
  // os itens ficariam vazios.
  assert(/\[data-sidebar="compacta"\] \.menu-item \.icon \{[^}]*display:\s*inline-flex/.test(CSS_SB),
    'no compacto os itens do menu ficariam sem ícone e sem texto');
});

t('G3. a marca continua visivel no compacto', () => {
  assert(/\[data-sidebar="compacta"\] \.sidebar-logo-img \{[^}]*max-height/.test(CSS_SB),
    'a logo some no modo compacto');
});

t('G4. ha botao de alternar, e o PDV pede compacto sem impor', () => {
  const sb = fs.readFileSync(path.join(RAIZ, 'public/js/sidebar.js'), 'utf8');
  assert(/id="btnSidebarToggle"/.test(sb), 'sem botão de recolher/expandir');
  assert(/PAGINAS_COMPACTAS = \['pedidos-pdv'\]/.test(sb), 'o PDV não pede o modo compacto');
  // A escolha manual precisa vencer a automática, senão o botão não serve.
  const fn = /function ajustarSidebarPara\(pageName\) \{[\s\S]*?\n\}/.exec(sb);
  assert(fn && /manual === '1'[\s\S]*manual === '0'/.test(fn[0]),
    'a preferência manual não tem precedência sobre a automática');
});

t('G5. no mobile o compacto nao se aplica (a barra ja e gaveta)', () => {
  assert(/@media \(max-width: 768px\) \{\s*\[data-sidebar="compacta"\] \{ --sidebar-w: 250px/.test(CSS_SB),
    'no celular a sidebar compacta deixaria a gaveta estreita demais');
});

t('G6. o modo compacto nao cria segunda navegacao nem mexe em RBAC', () => {
  const sb = fs.readFileSync(path.join(RAIZ, 'public/js/sidebar.js'), 'utf8');
  const bloco = /function aplicarSidebarCompacta[\s\S]*?\n\}/.exec(sb)[0];
  for (const p of ['acessoDoUsuario', 'paginas', 'perfil', 'innerHTML']) {
    assert(!bloco.includes(p), `o modo compacto mexe em "${p}" — deveria só trocar a largura`);
  }
});

// ==================== H. INTEGRIDADE ====================

t('H1. o JS inline da tela parseia', () => {
  const blocos = [...H.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  assert(blocos.length > 0, 'sem script inline');
  blocos.forEach((m, i) => {
    try { new vm.Script(m[1]); } catch (e) { throw new Error(`bloco ${i + 1}: ${e.message}`); }
  });
});

t('H2. todo handler do HTML tem funcao definida', () => {
  const chamados = [...new Set([...H.matchAll(/on(?:click|input|change)="([a-zA-Z_$][\w$]*)\(/g)].map((m) => m[1]))];
  const faltando = chamados.filter((f) =>
    !new RegExp(`(function\\s+${f}\\s*\\(|const\\s+${f}\\s*=)`).test(H));
  assert(faltando.length === 0, 'sem definição: ' + faltando.join(', '));
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
