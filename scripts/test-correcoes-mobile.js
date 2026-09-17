/**
 * Correções de 2026-09-12 — responsividade, login, descrição, PDF e link público.
 *
 * O teste que mais importa aqui é o bloco E: o link público abre uma porta no
 * sistema para quem NÃO tem conta. Se o recorte vazar custo, margem ou dado de
 * outro cliente, ninguém percebe olhando a tela — o orçamento aparece bonito e
 * correto, e o problema só vira notícia depois.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };
const semCom = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');

const CSS = fs.readFileSync(path.join(PUB, 'css/app-modern.css'), 'utf8');
const LOGIN = semCom(fs.readFileSync(path.join(PUB, 'auth/login.html'), 'utf8'));
const PEDIDO = fs.readFileSync(path.join(PUB, 'comercial/pedido.html'), 'utf8');
const PUBLICA = fs.readFileSync(path.join(PUB, 'auth/orcamento-comercial.html'), 'utf8');
const ROTAS = fs.readFileSync(path.join(RAIZ, 'pedidos-routes.js'), 'utf8');
const AUTH = fs.readFileSync(path.join(RAIZ, 'auth.js'), 'utf8');
const PDFJS = fs.readFileSync(path.join(RAIZ, 'pedido-pdf.js'), 'utf8');
const SB = fs.readFileSync(path.join(PUB, 'js/sidebar.js'), 'utf8');

// ============================================================================
// A. Responsividade global (item 1)
// ============================================================================

t('A1. o CSS global ganhou breakpoints de celular', () => {
  const mqs = [...CSS.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
  for (const px of [900, 640, 380]) {
    assert(mqs.includes(px), `falta o breakpoint de ${px}px`);
  }
});

t('A2. campos com 16px no celular (impede o zoom automatico do iOS)', () => {
  const bloco = /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert(bloco, 'breakpoint de 640px não encontrado');
  assert(/font-size: 16px !important/.test(bloco[1]),
    'os campos não têm 16px no celular — o iOS daria zoom ao focar');
  assert(/input, select, textarea/.test(bloco[1]), 'a regra não cobre input/select/textarea');
});

t('A3. NAO resolveram escondendo conteudo', () => {
  // `overflow-x: hidden` no body corta informação sem avisar. A instrução era
  // explícita: não resolver escondendo.
  assert(!/body\s*\{[^}]*overflow-x:\s*hidden/.test(CSS),
    'apareceu overflow-x:hidden no body — isso esconde o estouro em vez de corrigir');
  assert(!/display:\s*none[^;]*;\s*\}\s*\/\* colunas/.test(CSS), 'colunas escondidas no celular');
});

t('A4. tabelas ganham rolagem PROPRIA, sem esconder coluna', () => {
  assert(/\.tabela-rolagem \{[^}]*overflow-x: auto/.test(CSS), 'a classe .tabela-rolagem sumiu');
  assert(/overscroll-behavior-x: contain/.test(CSS),
    'rolar a tabela arrastaria a página junto');
  assert(/function envolverTabelas/.test(SB), 'a função que cria o wrapper sumiu');
});

t('A5. envolverTabelas e idempotente e roda nas duas entradas', () => {
  const fn = /function envolverTabelas\(raiz\)[\s\S]*?\n\}/.exec(SB)[0];
  assert(/closest\('\.tabela-rolagem'\)/.test(fn), 'envolveria a mesma tabela duas vezes');
  assert(/parentElement\.closest\('table'\)/.test(fn), 'envolveria tabela aninhada');
  const chamadas = (SB.match(/envolverTabelas\(\)/g) || []).length;
  assert(chamadas >= 3, `só ${chamadas} chamadas — esperado nos 2 caminhos de initSidebar + observer`);
});

t('A6. a descricao pode quebrar linha (item 3)', () => {
  assert(/\.tabela-rolagem td\.col-descricao[\s\S]{0,200}white-space: normal/.test(CSS),
    'a coluna de descrição não quebra linha no celular');
  assert(/col-descricao/.test(PEDIDO), 'a tela de pedido não marca a coluna de descrição');
});

// ============================================================================
// B. Login (item 2)
// ============================================================================

t('B1. campos do login com 16px e altura de toque', () => {
  const inp = /\.form-group input \{([^}]*)\}/.exec(LOGIN);
  assert(inp, 'regra do input não encontrada');
  assert(/font-size: 16px/.test(inp[1]), 'o input não tem 16px — o iOS daria zoom');
  assert(/min-height: 48px/.test(inp[1]), 'o input não tem altura confortável de toque');
  const btn = /\.btn-login \{([^}]*)\}/.exec(LOGIN);
  assert(/min-height: 50px/.test(btn[1]), 'o botão não tem altura de toque');
});

t('B2. login funciona com o teclado virtual aberto', () => {
  // `100vh` ignora o encolhimento do viewport quando o teclado sobe.
  assert(/min-height: 100dvh/.test(LOGIN), 'o login usa só 100vh — o card sairia da tela');
});

t('B3. o card do login cede espaco no celular estreito', () => {
  assert(/@media \(max-width: 420px\)/.test(LOGIN), 'sem breakpoint de celular');
  assert(/@media \(max-width: 360px\)/.test(LOGIN), 'sem breakpoint de celular estreito');
});

// ============================================================================
// C. PDF (itens 4 e 7)
// ============================================================================

t('C1. altura da linha e MEDIDA, nao estimada (causa da sobreposicao)', () => {
  assert(/heightOfString/.test(PDFJS),
    'a altura voltou a ser estimada — era a causa do item 30 escrever sobre a página seguinte');
  assert(!/Math\.ceil\(\(it\.descricao \|\| ''\)\.length \/ 50\)/.test(PDFJS),
    'o chute de 50 caracteres por linha voltou');
});

t('C2. cabecalho da tabela repete em cada pagina', () => {
  assert(/function desenharCabecalho/.test(PDFJS), 'o cabeçalho não virou função reutilizável');
  const addPages = [...PDFJS.matchAll(/doc\.addPage\(\);\s*\n\s*y = ([^;]+);/g)].map((m) => m[1]);
  assert(addPages.length > 0, 'nenhuma quebra de página encontrada');
  for (const destino of addPages) {
    assert(/desenharCabecalho/.test(destino),
      `uma quebra de página não redesenha o cabeçalho: y = ${destino}`);
  }
});

t('C3. o texto nao escapa da celula', () => {
  assert(/height: rowH - 4, ellipsis: true/.test(PDFJS),
    'as células não limitam a altura do texto');
});

t('C4. rodape em TODAS as paginas', () => {
  assert(/bufferPages: true/.test(PDFJS), 'sem bufferPages não dá para carimbar as páginas anteriores');
  assert(/switchToPage/.test(PDFJS), 'o rodapé continua só na última página');
  assert(/SEM VALOR FISCAL/.test(PDFJS), 'o aviso sumiu');
});

t('C5. download real, com nome amigavel', () => {
  assert(/req\.query\.download/.test(ROTAS), 'a rota não aceita ?download=1');
  assert(/attachment/.test(ROTAS), 'a rota nunca força o download');
  assert(/replace\(\/\[\^\\w\.-\]\+\/g, '-'\)/.test(ROTAS), 'o nome do arquivo não é higienizado');
  assert(/function baixarPdf/.test(PEDIDO), 'a tela não tem função de download');
  assert(/URL\.createObjectURL/.test(PEDIDO), 'o download não usa Blob — falharia no iPhone');
  assert(/Baixar PDF/.test(PEDIDO), 'não existe botão "Baixar PDF"');
});

// ============================================================================
// D. "Load failed" (item 6)
// ============================================================================

t('D1. a mensagem generica foi traduzida', () => {
  assert(/function mensagemDeRede/.test(SB), 'o helper global não existe');
  const m = /function mensagemDeRede\([^)]*\) \{[\s\S]*?\n\}/.exec(SB);
  assert(m, 'o helper global sumiu');
  const fn = m[0];
  assert(/load failed\|failed to fetch/i.test(fn), 'não reconhece a mensagem do WebKit/Chrome');
  assert(/console\.warn/.test(fn), 'o detalhe técnico se perde — deveria ir para o log');
  assert(/Verifique sua conexão/.test(fn), 'não há mensagem compreensível');
  // A tela do pedido tinha uma cópia própria que divergiu da global. Uma só.
  assert(!/function mensagemDeRede/.test(PEDIDO),
    'pedido.html voltou a ter cópia local de mensagemDeRede — elas divergem em silêncio');
});

t('D2. o helper de API da Venda rapida usa a traducao', () => {
  const pdv = fs.readFileSync(path.join(PUB, 'comercial/pedidos-pdv.html'), 'utf8');
  const api = /async function api\(url, opt\) \{[\s\S]*?\n\}/.exec(pdv)[0];
  assert(/catch \(e\)/.test(api), 'o fetch não trata falha de rede');
  assert(/mensagemDeRede/.test(api), 'não usa a tradução');
  assert(/401 \|\| r\.status === 403/.test(api), 'sessão expirada não tem mensagem própria');
});

// ============================================================================
// E. Link público do orçamento (item 5) — o bloco de segurança
// ============================================================================

t('E1. o token e aleatorio e longo, nao o id', () => {
  assert(/crypto\.randomBytes\(32\)\.toString\('hex'\)/.test(ROTAS),
    'o token não é 32 bytes aleatórios');
  assert(/\^\[a-f0-9\]\{64\}\$/.test(ROTAS), 'o formato do token não é conferido antes do banco');
});

t('E2. a rota publica NAO abre o painel', () => {
  // O bypass é só para o prefixo novo. Se `/api/pedidos/` entrasse aqui, o
  // sistema inteiro ficaria aberto.
  const bypasses = [...AUTH.matchAll(/req\.path\.startsWith\('([^']+)'\)\) return next\(\)/g)].map((m) => m[1]);
  assert(bypasses.includes('/api/orcamento-publico/'), 'a rota pública não foi liberada');
  for (const perigoso of ['/api/pedidos/', '/api/pessoas/', '/api/produtos/', '/api/']) {
    assert(!bypasses.includes(perigoso), `PERIGO: ${perigoso} foi liberado sem autenticação`);
  }
});

t('E3. o recorte publico NAO expoe dado interno', () => {
  const rota = /app\.get\('\/api\/orcamento-publico\/:token',[\s\S]*?\n  \}\);/.exec(ROTAS)[0];
  // O que o cliente vê é uma lista explícita; nada de `...pedido` ou SELECT *.
  assert(!/\.\.\.pedido/.test(rota), 'a rota espalha o pedido inteiro na resposta');
  for (const campo of ['precoCusto', 'custo', 'margem', 'vendedorId', 'vendedorNome',
                       'depositoId', 'tokenPublico', 'clienteCpfCnpj']) {
    assert(!new RegExp('\\b' + campo + '\\b').test(rota),
      `o recorte público expõe "${campo}"`);
  }
  assert(/status === 'cancelado'/.test(rota), 'orçamento cancelado continuaria visível');
});

t('E4. o token e revogavel', () => {
  assert(/app\.delete\('\/api\/pedidos\/:id\/link-publico'/.test(ROTAS), 'não há como revogar');
  assert(/SET tokenPublico = NULL/.test(ROTAS), 'revogar não limpa o token');
});

t('E5. a mensagem do WhatsApp leva o link PUBLICO', () => {
  const m = /async function enviarWhatsApp\([^)]*\)\{[\s\S]*?\n\}/.exec(PEDIDO);
  assert(m, 'a função enviarWhatsApp sumiu');
  const fn = m[0];
  assert(/obterLinkPublico/.test(fn), 'o WhatsApp não usa o link público');
  assert(!/\/api\/pedidos\/\$\{p\.id\}\/pdf/.test(fn),
    'a mensagem ainda manda a rota autenticada — o cliente cairia no login');
  assert(/p\.numero/.test(fn) && /valorTotal/.test(fn), 'a mensagem perdeu número ou valor');
});

t('E6. a pagina publica nao pede login nem leva ao painel', () => {
  assert(!/\/api\/pedidos\//.test(PUBLICA), 'a página pública chama a API interna');
  assert(!/login/i.test(semCom(PUBLICA).replace(/orcamento-publico/g, '')), 'a página menciona login');
  assert(/\/api\/orcamento-publico\//.test(PUBLICA), 'a página não usa a rota pública');
  assert(/SEM VALOR FISCAL/.test(PUBLICA), 'o aviso fiscal sumiu da página pública');
});

t('E7. a pagina publica e responsiva (vira cards no celular)', () => {
  assert(/@media \(max-width: 680px\)/.test(PUBLICA), 'sem breakpoint de celular');
  assert(/data-rot/.test(PUBLICA), 'as linhas não viram cards com rótulo');
  assert(/min-height: 48px/.test(PUBLICA), 'botões sem alvo de toque');
  assert(/font-size: 16px/.test(PUBLICA), 'botões abaixo de 16px');
});

// ============================================================================
// F. Schema — a coluna existe de verdade
// ============================================================================

t('F1. tokenPublico esta no db-schema (tenant novo tambem ganha)', () => {
  const schema = fs.readFileSync(path.join(RAIZ, 'db-schema.js'), 'utf8');
  assert(/'tokenPublico TEXT'/.test(schema), 'a coluna não entrou no schema');
  assert(/idx_pedidos_token_publico/.test(schema), 'sem índice, a busca pública varre a tabela');
  assert(/UNIQUE INDEX/.test(schema), 'o índice do token deveria ser único');
});

t('F2. a coluna existe nos tenants (migration aplicada)', () => {
  const base = path.join(RAIZ, 'data/tenants');
  if (!fs.existsSync(base)) return;
  const faltando = [];
  for (const tn of fs.readdirSync(base)) {
    const p = path.join(base, tn, 'pncp.db');
    if (!fs.existsSync(p)) continue;
    const db = new Database(p, { readonly: true });
    try {
      const cols = db.prepare('PRAGMA table_info(pedidos)').all().map((c) => c.name);
      if (!cols.includes('tokenPublico')) faltando.push(tn);
    } finally { db.close(); }
  }
  assert(faltando.length === 0, 'sem tokenPublico: ' + faltando.join(', '));
});

t('F3. o token so nasce na rota de compartilhar', () => {
  // ── Este teste media a coisa errada ────────────────────────────────────────
  //
  // Ele contava tokens nos bancos de PRODUÇÃO e exigia zero. Passou enquanto
  // ninguém havia usado a funcionalidade e reprovou em 12/09, no primeiro
  // compartilhamento real do ORC-2026-00003 — ou seja, reprovava justamente o
  // sistema funcionando. Um token em produção é a prova de que o recurso serve,
  // não de que algo o gerou sozinho.
  //
  // O que importa é a garantia de código: existe UM ponto que grava
  // `tokenPublico`, e ele é a rota POST que o botão chama.
  const escritas = [...ROTAS.matchAll(/UPDATE pedidos SET tokenPublico = [^N]/g)];
  assert(escritas.length === 1,
    `${escritas.length} pontos gravam tokenPublico — deveria haver só o da rota de compartilhar`);

  const rota = /app\.post\('\/api\/pedidos\/:id\/link-publico'[\s\S]*?\n  \}\);/.exec(ROTAS);
  assert(rota, 'a rota POST /link-publico sumiu');
  assert(/UPDATE pedidos SET tokenPublico = \?/.test(rota[0]),
    'a gravação do token saiu da rota de compartilhar');
  assert(/randomBytes\(32\)/.test(rota[0]), 'o token deixou de ser 32 bytes aleatórios');

  // Ler o pedido não pode criar token: se o GET gerasse, todo orçamento aberto
  // na tela nasceria compartilhável.
  const get = /app\.get\('\/api\/pedidos\/:id'[\s\S]*?\n  \}\);/.exec(ROTAS);
  if (get) assert(!/tokenPublico = /.test(get[0]), 'abrir o pedido está gerando token');
});

t('F4. revogar apaga o token de verdade', () => {
  const del = /app\.delete\('\/api\/pedidos\/:id\/link-publico'[\s\S]*?\n  \}\);/.exec(ROTAS);
  assert(del, 'a rota DELETE /link-publico sumiu');
  assert(/tokenPublico = NULL/.test(del[0]), 'a revogação não limpa o token');
  // Sem o token no banco, a rota pública não tem como casar — é o que faz o
  // link antigo parar de funcionar na hora, sem cache nem prazo.
  assert(/p\.tokenPublico = \?/.test(ROTAS), 'a leitura pública não casa pelo token');
});

(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
