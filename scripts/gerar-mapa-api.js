/**
 * gerar-mapa-api.js — regera perfis-api-map.js a partir do consumo real das telas.
 *
 * Uso:  node scripts/gerar-mapa-api.js
 *
 * O RBAC de API é fail-closed: prefixo sem entrada no mapa é negado. Manter esse
 * mapa à mão para ~150 prefixos seria uma fonte permanente de tela quebrada, então
 * ele é derivado: para cada .html de public/ (e cada .js que ele inclui) a varredura
 * recolhe as ocorrências de /api/<prefixo> e as atribui às páginas do menu daquele
 * arquivo. Telas de detalhe, que não estão no menu, atribuem ao módulo inteiro.
 *
 * O que a varredura NÃO consegue descobrir — rota que nenhuma tela chama — vive no
 * bloco COMPLEMENTO abaixo. É a única parte que se edita à mão.
 *
 * public/js/ fica de fora de propósito: sidebar.js entra em todas as telas, e herdar
 * dele mapearia os contadores do menu para as 140 páginas, o que na prática liberaria
 * esses prefixos para qualquer perfil.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const { menuConfig } = require(path.join(PUB, 'js/menu-config.js'));

// Rotas que nenhuma tela consome hoje, mapeadas à mão para o módulo a que
// pertencem. Sem elas o fail-closed barraria uso legítimo.
const COMPLEMENTO = {
  '/api/orgaos':                 ['consulta', 'agenda', 'interesse', 'sem-interesse'],
  '/api/lance':                  ['lances', 'blitz', 'propostas-api'],
  '/api/timeline-lances':        ['relatorio-lances'],
  '/api/relatorio-concorrentes': ['relatorio-lances'],
  '/api/credenciais':            ['consulta', 'propostas-api'],
  '/api/cfops-regras':           ['cadastro-cfops'],
  // Painel de certidões vencendo. Perdeu a tela própria quando o cadastro de
  // fornecedores foi unificado em `pessoas` (2026-08-20); a rota continua
  // servindo quem consulta a API.
  '/api/fornecedores-documentos':['pessoas'],
  '/api/rh':                     ['funcionarios', 'comissoes'],
  '/api/sc':                     ['conexoes', 'integracoes'],
  '/api/robo':                   ['conexoes', 'integracoes'],
  // Painéis da home (/index.html), que é o shell e por isso não herda de ninguém.
  '/api/sync':                   ['consulta', 'agenda', 'interesse', 'sem-interesse', 'status'],
};

const pagePorLink = new Map();
const pagesPorDir = new Map();
for (const s of menuConfig.secoes) {
  for (const i of s.itens) {
    pagePorLink.set(i.link, i.page);
    const dir = i.link.split('/')[1];
    if (!pagesPorDir.has(dir)) pagesPorDir.set(dir, []);
    pagesPorDir.get(dir).push(i.page);
  }
}

function listar(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['vendor', 'uploads', 'downloads', 'backups', 'extensions', 'img'].includes(e.name)) continue;
      out.push(...listar(p, ext));
    } else if (ext.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

const rel = (f) => '/' + path.relative(PUB, f);
const RE_API = /(\/api\/[a-z0-9._-]+)/gi;   // sem exigir aspa: telas montam `${API_URL}/api/...`

function prefixosDe(txt) {
  const s = new Set();
  RE_API.lastIndex = 0;
  let m;
  while ((m = RE_API.exec(txt))) s.add(m[1].toLowerCase());
  return s;
}

// ---------- páginas de cada arquivo ----------
// Tela fora do menu (pedido.html, contrato.html, electron-monitor.html) herda de
// QUEM A LINKA, não do módulo inteiro. Herdar do módulo inflava o mapa: bastava
// uma tela de detalhe chamar /api/sniper para o prefixo ficar ao alcance de
// quem só tem 'meu-perfil', porque as duas moram em /configuracoes/.
const paginasDoArquivo = new Map();
const htmls = listar(PUB, ['.html']);
const conteudo_ = new Map(htmls.map((f) => [f, fs.readFileSync(f, 'utf8')]));

// O shell não herda de ninguém: /app.html e /index.html são citados por toda a
// navegação, e deixá-los herdar espalharia as APIs da home para o sistema todo.
const SHELL = new Set(['/app.html', '/index.html']);

for (const f of htmls) {
  const set = new Set();
  const page = pagePorLink.get(rel(f));
  if (page) set.add(page);
  paginasDoArquivo.set(f, set);
}

// Casa `/pedido.html`, `"pedido.html`, `(pedido.html` — mas não o basename no
// meio de outra palavra nem em prosa solta.
const linkaPara = (txt, r) => {
  if (txt.includes(r)) return true;
  const base = path.basename(r).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`["'\`(=/]${base}`).test(txt);
};

// Duas passadas resolvem detalhe→detalhe (listagem → pedido.html → item.html).
for (let volta = 0; volta < 2; volta++) {
  for (const f of htmls) {
    const r = rel(f);
    if (pagePorLink.has(r) || SHELL.has(r)) continue;
    const set = paginasDoArquivo.get(f);
    for (const outro of htmls) {
      if (outro === f || SHELL.has(rel(outro))) continue;
      if (linkaPara(conteudo_.get(outro), r)) {
        for (const p of paginasDoArquivo.get(outro) || []) set.add(p);
      }
    }
  }
}

// Tela que ninguém linka e que não está no menu fica SEM páginas de propósito:
// é inalcançável pela navegação (resquício de reorganização de módulo, tela
// legada, acesso só por URL decorada). Herdá-la para o módulo era o que
// espalhava /api/sniper — que só a electron-monitor.html chama — para quem
// tinha qualquer página de /configuracoes/. Quem precisar de uma dessas telas
// usa perfil admin, ou ela ganha entrada no COMPLEMENTO.

for (const j of listar(PUB, ['.js']).filter((f) => !rel(f).startsWith('/js/'))) {
  const r = rel(j);
  const set = new Set();
  // Herda de quem o inclui (aceita cache-buster no src).
  for (const f of htmls) {
    const txt = conteudo_.get(f);
    if (txt.includes(`src="${r}"`) || txt.includes(`src='${r}'`)
        || txt.includes(`src="${r}?`) || txt.includes(`src='${r}?`)) {
      for (const p of paginasDoArquivo.get(f) || []) set.add(p);
    }
  }
  // Ninguém inclui: .js irmão de uma tela vale pela tela; solto, pelo módulo.
  if (!set.size) {
    const irmao = pagePorLink.get(r.replace(/\.js$/, '.html'));
    const dirJs = r.split('/')[1];
    if (irmao) set.add(irmao);
    else if (pagesPorDir.has(dirJs)) for (const p of pagesPorDir.get(dirJs)) set.add(p);
  }
  paginasDoArquivo.set(j, set);
}

// ---------- mapa ----------
const mapa = new Map();
for (const [arquivo, pages] of paginasDoArquivo) {
  if (!pages.size) continue;
  for (const pref of prefixosDe(fs.readFileSync(arquivo, 'utf8'))) {
    if (!mapa.has(pref)) mapa.set(pref, new Set());
    for (const p of pages) mapa.get(pref).add(p);
  }
}
for (const [k, v] of Object.entries(COMPLEMENTO)) {
  if (!mapa.has(k)) mapa.set(k, new Set());
  for (const p of v) mapa.get(k).add(p);
}

const chaves = [...mapa.keys()].sort();
const largura = Math.max(...chaves.map((k) => k.length)) + 3;
const linhas = chaves.map((k) =>
  `  ${(`'${k}':`).padEnd(largura)}[${[...mapa.get(k)].sort().map((p) => `'${p}'`).join(', ')}],`);

const conteudo = `/**
 * perfis-api-map.js — de qual página cada prefixo de API depende.
 *
 * ARQUIVO GERADO por \`node scripts/gerar-mapa-api.js\`. Não editar à mão: o que
 * precisa de ajuste manual é o bloco COMPLEMENTO daquele script.
 *
 * O gate de páginas (perfis-acesso.js) fecha a navegação; sem isto a API
 * continuaria aberta a quem soubesse o endereço do endpoint. A regra: um perfil
 * restrito pode chamar /api/<prefixo> se tiver acesso a ALGUMA das páginas
 * listadas aqui para esse prefixo.
 *
 * Prefixo fora deste arquivo é NEGADO (fail-closed, decisão de 2026-08-19).
 * Consequência que precisa ficar dita: rota nova sem entrada aqui quebra a tela
 * de quem tem perfil restrito. Quando acontecer, o servidor loga
 * '[RBAC] prefixo sem mapa: /api/xxx' — é esse log que diz o que falta.
 *
 * Fora do mapa DE PROPÓSITO (não é esquecimento):
 *   /api/backup, /api/versao, /api/debug  — já são requireRole(['admin'])
 *   /api/proxy                            — proxy genérico de saída
 *   /api/chat-ia, /api/kanban             — nenhuma tela atual os inclui
 *   /api/feriados                         — sem tela consumidora
 */

// Passam sempre: autenticação, preferências do próprio usuário, o que a sidebar
// precisa em toda página, e as rotas públicas (portal do cliente, loja, landing,
// control plane) que ficam antes da barreira de auth.
const LIBERADOS = [
  '/api/login', '/api/logout', '/api/change-password', '/api/auth',
  '/api/user', '/api/usuarios', '/api/perfis', '/api/features',
  '/api/estabelecimentos', '/api/estabelecimento-ativo',
  '/api/admin', '/api/landing', '/api/webhooks', '/api/portal', '/api/orcamento',
  '/api/electron', '/api/cotacao-publica', '/api/me', '/api/eu',
  '/api/carrinho', '/api/pedido', '/api/nfses', '/api/dashboard', '/api/loja',
];

// prefixo -> páginas do menu que legitimamente o consomem
const MAPA = {
${linhas.join('\n')}
};

module.exports = { LIBERADOS, MAPA };
`;

fs.writeFileSync(path.join(ROOT, 'perfis-api-map.js'), conteudo);
console.log(`perfis-api-map.js: ${chaves.length} prefixos mapeados`);
