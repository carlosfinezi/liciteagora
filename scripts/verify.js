/**
 * verify.js — a verificação de sintaxe do projeto, em um processo só.
 *
 *   npm run verify
 *
 * ── O que mudou, e por quê ──────────────────────────────────────────────────
 *
 * O verify antigo era:
 *
 *     find . scripts -maxdepth 1 -name '*.js' -print0 | xargs -0 -n1 node --check
 *
 * Ele tinha dois problemas, e o segundo custou caro:
 *
 *   1. LENTO: `xargs -n1 node` inicia UM PROCESSO NODE POR ARQUIVO. Com 521
 *      arquivos, 38,8 segundos — quase tudo gasto subindo e derrubando Node.
 *      Verificação lenta é verificação que se deixa de rodar.
 *
 *   2. CEGO PARA `public/`: `find . scripts -maxdepth 1` alcança só a raiz e
 *      `scripts/`. Em 2026-09-11 uma crase dentro de um comentário quebrou
 *      `public/js/sidebar.js`, o verify passou VERDE, e o ERP inteiro subiu com
 *      a tela em branco (relatório 25).
 *
 * Agora tudo roda em UM processo, com `vm.Script` — o mesmo parser do Node, sem
 * o custo de iniciá-lo 521 vezes. E a cobertura passa a incluir o que faltava.
 *
 * ── O que reprova ───────────────────────────────────────────────────────────
 *
 *   - SyntaxError em qualquer .js da raiz, de scripts/ ou de public/;
 *   - SyntaxError no JavaScript embutido nas telas do ERP;
 *   - qualquer uma das suítes funcionais listadas em `suites`, abaixo.
 *
 * ── As suítes funcionais ESTÃO aqui dentro ──────────────────────────────────
 *
 * Até 2026-09-17 este cabeçalho dizia que elas ficavam de fora de propósito, e
 * isso contradizia a lista logo abaixo: das 114 etapas, 3 são de sintaxe e 111
 * são suítes funcionais — shell, tema, PWA, RBAC, isolamento multi-tenant,
 * catálogo, pedidos, faturamento e SSL. Elas montam bancos descartáveis e
 * sobem Chrome headless, e são o motivo de a rodada levar ~35 minutos
 * (2.070s medidos em 16/09).
 *
 * Então o verify responde as duas perguntas: "isto carrega?" nas três
 * primeiras etapas, e "isto continua fazendo o que prometia?" nas outras 26.
 * O que ele NÃO responde é se a mudança que você acabou de fazer funciona:
 * nenhuma etapa conhece o seu diff.
 *
 * ── O que fica de fora, e por quê ───────────────────────────────────────────
 *
 * Existem ~104 outras suítes em scripts/ que não estão aqui. Parte delas não
 * pode entrar como está: dependem de artefatos em /tmp (ex.: test-usuarios
 * lê /tmp/vp-users-schema.sql) que somem no reboot, então entrariam já
 * quebradas. Entrar aqui exige ser auto-contida e determinística.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const t0 = Date.now();
let erros = 0;

// ==================== opções ====================
//   --rapido [arquivos…]  a sintaxe inteira e só as suítes ligadas aos arquivos
//                         (sem arquivos: os alterados em relação ao HEAD). Arquivo
//                         compartilhado (ver OBRIGA_INTEIRO) faz a rodada virar inteira.
//   --paralelo N          N suítes ao mesmo tempo (padrão 1, a ordem de sempre)
//   --json ARQUIVO        resultado estruturado, gravado no início e no fim
//   --tempos ARQUIVO      json de uma rodada anterior, para ordenar o paralelo
const ARGS = process.argv.slice(2);
const valorDe = (nome) => { const i = ARGS.indexOf(nome); return i >= 0 ? ARGS[i + 1] : undefined; };
const OPC = {
  rapido: ARGS.includes('--rapido'),
  paralelo: Math.max(1, parseInt(valorDe('--paralelo') || '1', 10) || 1),
  json: valorDe('--json'),
  tempos: valorDe('--tempos'),
};
const ARQS_RAPIDO = [];
if (OPC.rapido) {
  for (const a of ARGS.slice(ARGS.indexOf('--rapido') + 1)) { if (a.startsWith('--')) break; ARQS_RAPIDO.push(a); }
}

/**
 * Falha conhecida: reprova igual, mas sai marcada, para ninguém confundi-la com
 * regressão nova. Cada entrada leva data e motivo, e sai daqui quando a suíte
 * voltar a passar.
 */
const FALHAS_CONHECIDAS = {
  'test-catalogo-online-ux.js': '25/09/2026: o menu de Configurações do catálogo tem 7 opções desde 21/09 '
    + '(entrou "Regras fiscais") e a suíte espera 6. Ver CLAUDE.md.',
};

// ==================== trava: uma rodada por vez ====================
// Duas rodadas juntas disputam Chrome e CPU, e a mais lenta passa a reprovar por
// prazo. A trava vale para toda porta de entrada: npm, serviço ou à mão. O
// arquivo é 0666 porque o serviço roda como carlosfinezi e a sessão como root.
// Fica em /run/lock, e não em /tmp: o serviço tem /tmp próprio (PrivateTmp), e
// uma trava lá dentro não seria vista pelo `npm run verify` de fora.
const TRAVA = fs.existsSync('/run/lock') ? '/run/lock/liciteagora-verify.lock'
  : path.join(os.tmpdir(), 'liciteagora-verify.lock');
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
(function pegarTrava() {
  try {
    const fd = fs.openSync(TRAVA, 'wx', 0o666);
    fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
    try { fs.chmodSync(TRAVA, 0o666); } catch (_) { /* dono é outro usuário */ }
    return;
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const dono = parseInt(fs.readFileSync(TRAVA, 'utf8'), 10);
  if (dono && dono !== process.pid && vivo(dono)) {
    console.error(`verify: outra rodada em andamento (pid ${dono}); trava em ${TRAVA}`);
    process.exit(3);
  }
  fs.writeFileSync(TRAVA, String(process.pid)); // trava de rodada que morreu: assume
})();
process.on('exit', () => {
  try {
    if (fs.readFileSync(TRAVA, 'utf8').trim() === String(process.pid)) {
      try { fs.unlinkSync(TRAVA); } catch (_) { fs.writeFileSync(TRAVA, ''); }
    }
  } catch (_) { /* já não existe */ }
});
const filhos = new Set();
for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => { for (const f of filhos) f.kill('SIGKILL'); process.exit(130); });
}

// ==================== resultado estruturado (--json) ====================
// Gravado no início com estado "rodando" e no fim com "concluido": quem volta
// depois lê o arquivo, em vez de depender de estar olhando quando acabar.
const git = (...a) => { try { return execFileSync('git', a, { cwd: RAIZ, encoding: 'utf8' }).trim(); } catch (_) { return null; } };
const RESULTADO = {
  estado: 'rodando', pid: process.pid, inicio: new Date().toISOString(), fim: null, segundos: null,
  commit: git('rev-parse', 'HEAD'),
  arvoreSuja: (git('status', '--porcelain') || '').split('\n').filter(Boolean).length,
  modo: OPC.rapido ? 'rapido' : 'inteiro', paralelo: OPC.paralelo,
  etapas: [], falhas: [], totalFalhas: 0, falhasNovas: 0,
};
function gravarJson() {
  if (!OPC.json) return;
  const tmp = OPC.json + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(RESULTADO, null, 2));
  fs.renameSync(tmp, OPC.json);
}
gravarJson();

let etapaAtual = '';
const falhar = (msg, arq) => {
  console.error('  FALHA  ' + msg); erros++;
  const conhecida = !!(arq && FALHAS_CONHECIDAS[arq]);
  RESULTADO.falhas.push({ etapa: etapaAtual, arquivo: arq || null, msg, conhecida });
};
const passo = (txt) => { etapaAtual = txt; process.stdout.write(('  ' + txt).padEnd(50)); };

/** Ignorados em toda varredura: dependências e artefatos. */
const IGNORAR = new Set(['node_modules', '.git', 'dist', 'data', 'backups', 'uploads']);

function listarJs(dir, profundidade) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (profundidade > 0) out.push(...listarJs(p, profundidade - 1));
    } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Parse com o motor do Node, sem executar.
 *
 * `vm.Script` compila e para — nenhuma linha do arquivo roda, então verificar um
 * script que apaga o banco é tão seguro quanto verificar um comentário.
 *
 * ── Cada arquivo é parseado COMO É CARREGADO ────────────────────────────────
 *
 * Módulo CommonJS (raiz, scripts/) é envolvido pelo Node numa função antes de
 * compilar. É por isso que `return` no topo funciona lá — `scripts/rollout-fase1-tenants.js`
 * usa `if (require.main !== module) return;` e roda sem problema. Parseado como
 * script solto, o mesmo arquivo daria "Illegal return statement": um falso
 * positivo que reprovaria código correto.
 *
 * Já `public/js/*.js` e o `<script>` das telas são carregados pelo navegador
 * como SCRIPT, sem wrapper nenhum. Ali um `return` no topo é erro de verdade, e
 * envolver o fonte esconderia o defeito.
 *
 * @param {'modulo'|'script'} formato  como o arquivo é realmente carregado
 */
function parsear(arquivo, fonte, formato) {
  // Shebang (`#!/usr/bin/env node`): o Node o remove antes de compilar, e 96
  // scripts deste projeto começam assim. Mantê-lo daria "Invalid or unexpected
  // token" em arquivos perfeitamente válidos — falso positivo que faria o verify
  // reprovar o que sempre funcionou.
  const limpo = fonte.startsWith('#!') ? fonte.replace(/^#![^\n]*/, '') : fonte;
  const envolto = formato === 'modulo'
    ? `(function (exports, require, module, __filename, __dirname) {${limpo}\n});`
    : limpo;
  try {
    new vm.Script(envolto, { filename: arquivo });
    return null;
  } catch (e) {
    // ESM num projeto CommonJS: `import`/`export` no topo não compilam como
    // script. Não é erro de sintaxe — é outro formato, e o Node o trataria pela
    // extensão. Não reprova o que funciona.
    if (/Cannot use import statement|Unexpected token 'export'/.test(e.message)) return null;
    return e.message.split('\n')[0];
  }
}

console.log('verify — sintaxe e integridade da camada carregável\n');

// ==================== 1. JavaScript do servidor ====================
passo('1. .js da raiz e de scripts/');
{
  const arquivos = listarJs(RAIZ, 0).concat(listarJs(path.join(RAIZ, 'scripts'), 0));
  let n = 0;
  for (const f of arquivos) {
    const e = parsear(f, fs.readFileSync(f, 'utf8'), 'modulo');
    if (e) { console.log(''); falhar(`${path.relative(RAIZ, f)}: ${e}`); } else n++;
  }
  console.log(`${n}/${arquivos.length} OK`);
}

// ==================== 2. JavaScript do navegador ====================
// A lacuna que deixou o ERP com a tela branca.
passo('2. .js de public/');
{
  const arquivos = listarJs(path.join(RAIZ, 'public'), 12);
  let n = 0;
  for (const f of arquivos) {
    const e = parsear(f, fs.readFileSync(f, 'utf8'), 'script');
    if (e) { console.log(''); falhar(`${path.relative(RAIZ, f)}: ${e}`); } else n++;
  }
  console.log(`${n}/${arquivos.length} OK`);
}

// ==================== 3. JavaScript embutido nas telas ====================
passo('3. <script> inline das telas do ERP');
{
  const telas = [];
  (function varrer(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (IGNORAR.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) varrer(p);
      else if (e.name.endsWith('.html')) telas.push(p);
    }
  })(path.join(RAIZ, 'public'));

  let blocos = 0, comErro = 0;
  for (const f of telas) {
    const html = fs.readFileSync(f, 'utf8');
    // Só as telas do ERP: as públicas (landing, portal, loja) têm outro dono e
    // outro ciclo, e reprovar o verify por causa delas pararia o fechamento.
    if (!html.includes('/js/sidebar.js')) continue;
    for (const [i, m] of [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].entries()) {
      blocos++;
      const e = parsear(`${f}#${i + 1}`, m[1], 'script');
      if (e) { console.log(''); falhar(`${path.relative(RAIZ, f)} bloco ${i + 1}: ${e}`); comErro++; }
    }
  }
  console.log(`${blocos - comErro}/${blocos} OK`);
}

// ==================== 4. O shell inicializa ====================
// Parsear não basta: o arquivo pode compilar e ainda assim não montar o menu.
const suites = [
  ['4. shell monta (test-shell-boot)', 'test-shell-boot.js'],
  ['5. tema e contraste (test-tema-global)', 'test-tema-global.js'],
  // A topbar entra aqui porque ela é o caminho do logout. Um erro que a deixe
  // pela metade não derruba o shell — o `try` dela segura —, tira só o "Sair",
  // e isso não aparece em nenhuma outra verificação.
  ['6. topbar global (test-fase33-topbar)', 'test-fase33-topbar.js'],
  // A marca entra aqui porque ela não avisa quando quebra: um id de máscara
  // repetido entre os dois SVG embutidos recorta o desenho no lugar errado,
  // sem erro no console e sem nada que apareça numa tela qualquer.
  ['7. identidade visual (test-fase34-identidade)', 'test-fase34-identidade.js'],
  // Navegação da Venda rápida: o que pode quebrar aqui é oferecer um botão
  // para quem o RBAC barra, ou deixar a tela de balcão sem caminho de volta.
  // Nenhum dos dois aparece num teste de sintaxe.
  ['8. venda rapida (test-venda-rapida-nav)', 'test-venda-rapida-nav.js'],
  // Página registrada para RBAC e oculta da barra. Entra aqui porque o modo de
  // falha é silencioso: apagar a linha do menu "para limpar a sidebar" abre a
  // tela para qualquer perfil do mesmo diretório, sem erro nenhum.
  ['9. menu oculto + RBAC (test-menu-oculto-rbac)', 'test-menu-oculto-rbac.js'],
  // PWA. Entra aqui porque o service worker roda FORA da sessão e vê todas as
  // requisições: um erro na política de cache grava resposta autenticada no
  // disco do aparelho, sem erro no console e sem nada visível na tela.
  ['10. PWA (test-pwa)', 'test-pwa.js'],
  // Responsividade, login, PDF e o LINK PÚBLICO do orçamento. Entra aqui
  // sobretudo pelo último: é uma porta para quem não tem conta, e um recorte
  // que vaze custo ou margem não aparece na tela — o orçamento fica bonito.
  ['11. correcoes mobile (test-correcoes-mobile)', 'test-correcoes-mobile.js'],
  // DANFE e lista de separação. Entra aqui porque os dois são PDFs impressos e
  // levados ao balcão: uma linha sobreposta ou um preço de custo vazando para a
  // lista de separação não aparecem em teste de sintaxe nenhum.
  ['12. separacao e DANFE (test-separacao-danfe)', 'test-separacao-danfe.js'],
  // Isolamento multi-tenant. É o passo mais importante desta lista: a falha aqui
  // não quebra tela nenhuma — o sistema responde normalmente, só que com os
  // dados da empresa errada.
  ['13. isolamento multi-tenant (test-isolamento-tenant)', 'test-isolamento-tenant.js'],
  // Fluxo do orçamento. O bloco A é o único lugar do projeto que procura
  // VARIÁVEL INEXISTENTE no JavaScript das telas — exatamente o que o passo 3
  // aqui em cima não vê: `PEDIDO.numero` parseia perfeitamente e só quebra
  // quando a linha executa, no celular de quem está usando o sistema.
  ['14. fluxo do orcamento (test-orcamento-pwa)', 'test-orcamento-pwa.js'],
  // Responsividade MEDIDA no Chrome, nas cinco larguras de celular. Entra aqui
  // porque estouro horizontal não aparece em nenhuma leitura de CSS: a regra
  // pode estar escrita e perder para outra de especificidade maior.
  ['15. responsivo real (test-orcamento-responsivo)', 'test-orcamento-responsivo.js'],
  // Carga da Venda rápida. Entra aqui porque o modo de falha é MUDO: a tela
  // abre, o console fica limpo, e a grade simplesmente nunca sai do esqueleto.
  // Nenhuma leitura de código vê isso — é preciso responder à tela de forma
  // hostil (erro, vazio, e sobretudo NUNCA responder) e olhar o que sobra.
  ['16. carga da venda rapida (test-venda-rapida-carga)', 'test-venda-rapida-carga.js'],
  // Descrição da listagem de Produtos. Entra aqui pela garantia do bloco A: o
  // texto COMPLETO continua no DOM mesmo com o "…" na tela. Se alguém truncar
  // na montagem, a tela continua parecendo certa — e o tooltip passa a mostrar
  // o mesmo texto cortado, sem nada que denuncie.
  ['17. descricao em Produtos (test-produtos-descricao)', 'test-produtos-descricao.js'],
  // Categorias de produto. Entra aqui pelo rename: ele toca `produtos` E
  // `comissoes_regras`, que casa a categoria por texto exato. Um rename que
  // atualize só metade não dá erro — a comissão sai errada no fim do mês.
  ['18. categorias de produto (test-categorias-produtos)', 'test-categorias-produtos.js'],
  // Catálogo Online. Entra aqui pela garantia que sustenta a fase: NÃO existe
  // "produto do catálogo" — a central edita o produto do ERP. Uma tabela
  // espelho criada "para simplificar" faria o catálogo divergir do estoque e
  // do preço sem erro nenhum.
  ['19. catalogo online (test-catalogo-online)', 'test-catalogo-online.js'],
  // Relatório SSL. Entra aqui por um defeito que não dá erro nenhum: ao receber
  // um `Date`, a lib `xlsx` compensa fuso contra 30/12/1899 — data em que
  // America/Sao_Paulo ainda está em LMT — e o serial sai fracionário. O Excel
  // trunca, e toda data do relatório aparece um dia antes, sem aviso. O mesmo
  // vale para domínio e número de pedido truncados na coluna do PDF: continuam
  // um relatório bonito, só que apontando para a compra errada.
  ['20. relatorio SSL xlsx/pdf (test-ssl-relatorio)', 'test-ssl-relatorio.js'],
  // UX da central do Catálogo Online. Entra aqui porque o que ela protege só
  // existe rodando: barra de categorias, painel lateral e alvos de toque não
  // aparecem em leitura de código, e elemento no DOM não prova que se vê.
  ['21. UX do catalogo online (test-catalogo-online-ux)', 'test-catalogo-online-ux.js'],
  // Cabeçalho, ordenação da vitrine e upload dentro do contexto de tenant. O de
  // upload sobe a cadeia HTTP inteira: o defeito que ele guarda (o multer
  // perdendo o AsyncLocalStorage) só aparece com busboy de verdade no caminho.
  ['22. cabecalho e ordem do catalogo (test-catalogo-48)', 'test-catalogo-48.js'],
  ['23. upload de logo e banner (test-catalogo-48-upload)', 'test-catalogo-48-upload.js'],
  // Desconto em reais com alçada em percentual, e o comprovante de recebimento
  // na fatura. O PDF é gerado e lido com pdftotext — conferir a string no fonte
  // provaria a letra certa, não o que sai no papel nem em que página sai.
  ['24. desconto em R$ e fatura (test-desconto-reais-fatura)', 'test-desconto-reais-fatura.js'],
  // Integração Catálogo Online -> /loja/. Guarda o que o público NÃO pode ter:
  // custo no payload, dado de outro tenant, exigência de login, e a confusão
  // entre "catálogo vazio" e "busca sem resultado" que atrasou o diagnóstico.
  ['25. catalogo publico (test-catalogo-publico-49)', 'test-catalogo-publico-49.js'],
  // Catálogo público com produto, personalização e carrinho. O que ele guarda
  // é uma frase só: o navegador não sabe quanto as coisas custam. Metade dos
  // casos adultera o localStorage e exige que o servidor continue mandando.
  ['26. produto e carrinho publico (test-catalogo-fase50)', 'test-catalogo-fase50.js'],
  // Acabamento e Informações da empresa. O que ele guarda é o dado que vira
  // href numa página aberta à internet: `javascript:` e domínio disfarçado
  // barrados, endereço só com opt-in, e nada vazando entre tenants.
  ['27. informacoes da empresa (test-catalogo-fase51)', 'test-catalogo-fase51.js'],
  // Contrato -> pedido de compra. Entra aqui porque a regra tem dois lados que
  // se contradizem se um deles for esquecido: gerar de novo É legítimo (item
  // anual pede uma compra por ciclo, é o que `ciclosNaVigencia` conta), e ao
  // mesmo tempo o clique repetido já encheu o tenant 1bit de pedido cancelado
  // à mão. Uma "correção" que só bloqueie passa em qualquer leitura de código
  // e quebra a renovação no ano seguinte, quando ninguém mais lembra daqui.
  ['28. contrato sem pedido duplicado (test-contrato-pedido-duplicado)', 'test-contrato-pedido-duplicado.js'],
  // Contato de certificado OV/EV. Entra aqui porque o defeito só existe no
  // cruzamento de duas coisas raras: produto que valida organização E contato
  // preenchido no certificado. Rodou meses sem aparecer — as seis compras OV
  // anteriores tinham o contato vazio. O que ele guarda é a mescla (contato do
  // cliente SOBRE o do tenant, não no lugar dele) e a guarda que barra antes
  // de gastar a ida à NicSRS, nos TRÊS caminhos que chegam ao /ssl/place.
  ['29. contato OV/EV da NicSRS (test-ssl-contato-ov)', 'test-ssl-contato-ov.js'],
  // Ciclo de reemissão SSL. Entra aqui porque o que ele guarda só falha DEPOIS
  // de a conta estar paga: o arquivo vale menos que a assinatura, e quem cobre
  // a diferença é o reissue automático. A janela acompanha a validade — é o que
  // mantém a regra correta quando o teto das CAs cair de 200 para 47 dias, sem
  // ninguém reconfigurar nada. E DCV por e-mail ganha o dobro dela, porque
  // depende de um clique do cliente: sem o clique, o certificado expira.
  ['30. reemissao e DCV manual (test-ssl-reissue-dcv)', 'test-ssl-reissue-dcv.js'],
  // Entrou em 17/09 por ter pego, sozinha, o defeito que ninguém viu: a tela
  // cancelava certificado SEM confirmação e com motivo fixo, para uma ação
  // irreversível que não devolve o valor pago. A suíte existia desde 31/08 e
  // estava certa; o que faltava era alguém executá-la. Custo: ~40s.
  ['30. cancelar certificado pede confirmação (test-ssl-cancelar-ui)', 'test-ssl-cancelar-ui.js'],

  // ── Fiscal: tributação, apuração e emissão ──
  ['31. fiscal-tributacao (0s)', 'test-fiscal-tributacao.js'],
  ['32. fiscal-regras (1s)', 'test-fiscal-regras.js'],
  ['33. fiscal-diagnostico (4s)', 'test-fiscal-diagnostico.js'],
  ['34. camada3-fiscal (1s)', 'test-camada3-fiscal.js'],
  ['35. regras-tributarias-ui (3s)', 'test-regras-tributarias-ui.js'],
  ['36. nfe-tributacao-integracao (0s)', 'test-nfe-tributacao-integracao.js'],
  ['38. nf-avulsa (0s)', 'test-nf-avulsa.js'],
  ['39. nova-nota-ui (4s)', 'test-nova-nota-ui.js'],
  ['40. espelho-fiscal (0s)', 'test-espelho-fiscal.js'],
  ['41. documento-fiscal (1s)', 'test-documento-fiscal.js'],
  ['42. emissao-estabelecimento (9s)', 'test-emissao-estabelecimento.js'],
  ['43. apuracao-icms (3s)', 'test-apuracao-icms.js'],
  ['44. apuracao-ipi (3s)', 'test-apuracao-ipi.js'],
  ['45. apuracao-piscofins (3s)', 'test-apuracao-piscofins.js'],

  // ── Devolução de venda ──
  ['46. devolucao-venda-espelho (10s)', 'test-devolucao-venda-espelho.js'],
  ['47. devolucoes-credito-metas-comissao (2s)', 'test-devolucoes-credito-metas-comissao.js'],
  ['48. devolucoes-custo-saldo-estorno (1s)', 'test-devolucoes-custo-saldo-estorno.js'],

  // ── Estoque e catálogo de atributos ──
  ['49. analises-estoque (16s)', 'test-analises-estoque.js'],
  ['50. deposito-movimentacao (20s)', 'test-deposito-movimentacao.js'],
  ['51. multideposito-lab (1s)', 'test-multideposito-lab.js'],
  ['52. etiquetas (1s)', 'test-etiquetas.js'],
  ['53. sync-marcadores (1s)', 'test-sync-marcadores.js'],

  // ── Farmácia ──
  ['54. farmacia-f0 (0s)', 'test-farmacia-f0.js'],
  ['55. farmacia-f1 (21s)', 'test-farmacia-f1.js'],
  ['56. farmacia-f2 (1s)', 'test-farmacia-f2.js'],
  ['57. farmacia-f3 (0s)', 'test-farmacia-f3.js'],
  ['58. farmacia-f4 (1s)', 'test-farmacia-f4.js'],
  ['59. farmacia-f5 (0s)', 'test-farmacia-f5.js'],
  ['60. farmacia-f6 (1s)', 'test-farmacia-f6.js'],

  // ── Locação ──
  ['61. locacao-f0 (1s)', 'test-locacao-f0.js'],
  ['62. locacao-f1 (0s)', 'test-locacao-f1.js'],
  ['63. locacao-f2 (1s)', 'test-locacao-f2.js'],
  ['64. locacao-f3 (0s)', 'test-locacao-f3.js'],
  ['65. locacao-f4 (1s)', 'test-locacao-f4.js'],
  ['66. locacao-f5 (0s)', 'test-locacao-f5.js'],
  ['67. locacao-f6 (1s)', 'test-locacao-f6.js'],
  ['68. locacao-f7 (1s)', 'test-locacao-f7.js'],

  // ── Produção ──
  ['69. producao-f0 (0s)', 'test-producao-f0.js'],
  ['70. producao-f2 (13s)', 'test-producao-f2.js'],
  ['71. producao-sem-rh (11s)', 'test-producao-sem-rh.js'],
  ['72. producao-telas (25s)', 'test-producao-telas.js'],

  // ── PDV e varejo ──
  ['73. pdv-fluxo (19s)', 'test-pdv-fluxo.js'],
  ['74. pdv-natureza (1s)', 'test-pdv-natureza.js'],
  ['75. pdv-rbac (0s)', 'test-pdv-rbac.js'],
  ['76. pdv-visual (0s)', 'test-pdv-visual.js'],

  // ── Pedido: desconto, pagamento e rollout ──
  ['77. fase1-funcional (13s)', 'test-fase1-funcional.js'],
  ['78. fase1-desconto-origem (12s)', 'test-fase1-desconto-origem.js'],
  ['79. fase1-rollout-parcial (10s)', 'test-fase1-rollout-parcial.js'],
  ['80. fase0-pagamento-pedido (10s)', 'test-fase0-pagamento-pedido.js'],
  ['81. rollout-fase1 (1s)', 'test-rollout-fase1.js'],
  ['82. reservas-pedido (7s)', 'test-reservas-pedido.js'],
  ['83. venda-perdida-pedido (6s)', 'test-venda-perdida-pedido.js'],
  ['84. status-negocio (0s)', 'test-status-negocio.js'],

  // ── Governança e notificações ──
  ['85. alcadas (11s)', 'test-alcadas.js'],
  ['86. governanca-percentual (9s)', 'test-governanca-percentual.js'],
  ['87. notificacoes-canais (0s)', 'test-notificacoes-canais.js'],

  // ── Licitações ──
  ['88. interesse-analise (18s)', 'test-interesse-analise.js'],
  ['89. interesse-relatorio (3s)', 'test-interesse-relatorio.js'],

  // ── Financeiro ──
  ['90. tarifas (6s)', 'test-tarifas.js'],
  ['91. metas-bi (6s)', 'test-metas-bi.js'],

  // ── Core e provisionamento ──
  ['92. app-backend (27s)', 'test-app-backend.js'],
  ['93. provisionamento-tenant-novo (1s)', 'test-provisionamento-tenant-novo.js'],

  // ── Interface ──
  ['94. fase321-ux (0s)', 'test-fase321-ux.js'],
  ['95. sidebar-botoes (0s)', 'test-sidebar-botoes.js'],

  // ── Lotes de laboratório (regressão acumulada) ──
  ['96. item12-lab (0s)', 'test-item12-lab.js'],
  ['97. item13-lab (1s)', 'test-item13-lab.js'],
  ['98. item21-lab (0s)', 'test-item21-lab.js'],
  ['99. lote22-23-lab (0s)', 'test-lote22-23-lab.js'],
  ['100. lote25-26-lab (0s)', 'test-lote25-26-lab.js'],
  ['101. onda3-lab (0s)', 'test-onda3-lab.js'],
  // ── Recuperadas do dump em /tmp (ver scripts/schema-de-tenant.js) ──
  ['101. comunicacao (11s)', 'test-comunicacao.js'],
  ['102. contrato-recorrencia (8s)', 'test-contrato-recorrencia.js'],
  ['103. produto-imagens (8s)', 'test-produto-imagens.js'],
  ['104. recorrencias-crud (9s)', 'test-recorrencias-crud.js'],
  ['105. rh-clt (12s)', 'test-rh-clt.js'],
  ['106. upload-ofx (9s)', 'test-upload-ofx.js'],
  // Faturamento do contrato por nota avulsa. Entra aqui porque o modo de falha
  // é silencioso: vincular a nota errada, ou perder o vínculo de outro
  // contrato, não quebra tela nenhuma — o contrato só passa a exibir um
  // faturamento que não é dele.
  ['107. contrato-nfse-avulsa (25s)', 'test-contrato-nfse-avulsa.js'],
  ['108. contrato-nfse-ui (22s)', 'test-contrato-nfse-ui.js'],
  // Dono da conversa. O modo de falha é silencioso e caro: "Minhas" trazendo o
  // que é de outro faz dois atendentes responderem o mesmo cliente, e nada na
  // tela denuncia isso.
  ['110. conversas-dono (1s)', 'test-conversas-dono.js'],
  // Aviso de mensagem nova. O defeito que importa é avisar na primeira carga:
  // alarme sobre mensagem de ontem faz a pessoa desligar o aviso para sempre, e
  // aí o recurso existe sem servir a ninguém.
  ['111. conversas-aviso (0s)', 'test-conversas-aviso.js'],
  // Horário de atendimento. É a única porta do webhook que CALA a IA, e os dois
  // modos de falha são invisíveis: fechar cedo demais responde "estamos
  // fechados" às duas da tarde; abrir demais promete retorno às três da manhã.
  ['112. atendimento-horario (0s)', 'test-atendimento-horario.js'],
  // Base da IA por PDF. Sobe um PDF de verdade e roda o pdftotext de verdade:
  // com stub, o teste provaria que o stub funciona. O defeito guardado é o
  // truncar calado, que deixa a IA respondendo com meia informação.
  ['113. ia-base-pdf (2s)', 'test-ia-base-pdf.js'],
  // A inbox redesenhada e a separação em duas telas. Sobe Chrome porque o que
  // está sob teste é o que a pessoa VÊ: marca que aparece em toda linha vira
  // textura, e contar innerHTML não distingue uma coisa da outra.
  ['114. conversas-ux (5s)', 'test-conversas-ux.js'],
  // Pop-up de mensagem nova. O Web Push foi escrito à mão (sem `npm install`), e
  // os dois modos de falha não dão erro legível: assinatura em DER vira 401 mudo
  // no servidor de push, e chave pública no formato errado faz o navegador
  // recusar a inscrição. A suíte verifica a assinatura como o Google verifica.
  ['115. push-mensagem (1s)', 'test-push-mensagem.js'],
  // Modelo de IA por tenant. O modo de falha é o pior tipo: a tela mostra o
  // modelo novo, a requisição sai com o velho, e o 404 do provider continua
  // igual — ninguém tem como saber que a escolha não valeu. Por isso a suíte
  // intercepta a chamada e lê o ID que realmente viajou.
  ['114. modelo de IA por tenant (test-ia-modelo-config)', 'test-ia-modelo-config.js'],
  // Listas de campanha. O defeito guardado é de leitura, e por isso passava
  // despercebido: um JOIN interno com `pessoas` escondia os 27.775 contatos
  // importados do legado, que não são clientes cadastrados. A tela mostrava
  // três listas vazias e ninguém sabia dizer se o dado tinha sumido.
  ['116. listas de campanha (test-listas-membros)', 'test-listas-membros.js'],
  // Tom e limites por botão. A etapa que importa é a A5: tenant que não
  // escolheu nada precisa receber o prompt exatamente como era, senão a
  // mudança vaza para os outros dez sem ninguém ter pedido.
  ['117. tom e limites da IA (test-ia-estilo)', 'test-ia-estilo.js'],
  // Dor por segmento e modelo da campanha. Os dois modos de falha guardados
  // aqui são silenciosos: segmento com contato e sem frase manda todo mundo
  // para a genérica, e frase gravada em chave que `chaveDoRamo` não devolve
  // nunca é sorteada. Nenhum dos dois dá erro em lugar nenhum.
  ['118. segmentos da campanha (test-campanha-segmentos)', 'test-campanha-segmentos.js'],
  // Agendamento de reunião pelo próprio contato. O cálculo dos horários roda com
  // o relógio fixado por parâmetro: suíte que lê a hora do sistema passa hoje e
  // reprova num feriado, e aí alguém a desliga em vez de consertá-la.
  ['119. horarios de reuniao (test-agenda-reuniao)', 'test-agenda-reuniao.js'],
  // O mesmo agendamento de ponta a ponta. A etapa que importa é a C2: dois
  // contatos clicando no mesmo horário. Sem o índice único parcial, os dois
  // saem da tela achando que têm as 10h, e a duplicidade só aparece na hora.
  ['120. agendamento publico (test-agenda-publica)', 'test-agenda-publica.js'],
  // Roteiros de venda. A etapa que mais importa é a que prova que o peso pode
  // mudar amanhã sem reescrever a visita de ontem, e a que recusa roteiro com
  // variável sem valor: o texto é lido em voz alta na frente do cliente.
  ['121. roteiros de venda (test-roteiros)', 'test-roteiros.js'],
  // O registro de visita em campo, medido em viewport de celular: alvo de toque
  // pequeno faz o vendedor errar a resposta na frente do cliente.
  ['122. visita em campo (test-visita-campo)', 'test-visita-campo.js'],
  // Horário do último scan. O SQLite grava CURRENT_TIMESTAMP em UTC, e a tela
  // lia cru: em -03 isso adiantava o relógio em 3h e anunciava um scan que
  // ainda não tinha acontecido. A suíte fixa o fuso do navegador, senão
  // passaria em máquina que já estivesse em UTC, medindo nada.
  ['129. horario do scan (test-scan-horario)', 'test-scan-horario.js'],
  // Lacunas do catálogo PNCP. Guarda o incidente de 22/09/2026, em que o
  // catálogo caiu de ~5.400 publicações por dia útil para 116: a verificação
  // contava no SQLite congelado enquanto escrevia no Postgres, concluía que
  // faltava tudo, refazia o download completo a cada rodada e o PNCP passou a
  // recusar as chamadas. As três guardas — ler no banco certo, contar só o que
  // gravou, e parar no 429 — são o que o teste exercita.
  ['130. lacunas do catalogo (test-lacunas-catalogo)', 'test-lacunas-catalogo.js'],
  // Freios do sync incremental. Ele roda de 5 em 5 minutos e era a única rotina
  // sem nenhum: cinco retries IMEDIATOS por página recusada, sem cooldown, e
  // paginação sempre da página 1 rebaixando o dia inteiro. Consumia a cota da
  // API que a varredura de 45 dias precisa — a única que recompõe dias fora da
  // janela de dois dias, como o 21/09 que ficou em 5% de cobertura.
  ['131. freio do sync incremental (test-sync-incremental-freio)', 'test-sync-incremental-freio.js'],
  // Recorrências. Guarda três defeitos que chegavam ao cliente: o e-mail em
  // dobro (a emissão mandava o dela além do da recorrência), a conta nascendo
  // vencida quando executada depois do dia, e o "Executar todas" num POST só,
  // que estourava o proxy com centenas. Roda a emissão real com SEFIN, assinatura
  // e e-mail trocados, e conta quantas mensagens sairiam.
  ['132. recorrencias em lote (test-recorrencia-lote)', 'test-recorrencia-lote.js'],
  // Vínculo de certificado com contrato. Entra aqui pelo sintoma, que é o pior
  // que existe: a tela dizia "Certificado atualizado" e o vínculo não mudava.
  // Eram dois defeitos somados — o corpo do PUT não levava os campos, e
  // `contratoItemId` estava em SO_GESTAO (aceito) e fora da lista do UPDATE
  // (descartado). As checagens olham o BANCO depois do PUT, e não a resposta,
  // porque os dois respondiam `success`.
  ['133. vinculo de certificado com contrato (test-ssl-vinculo-contrato)', 'test-ssl-vinculo-contrato.js'],
  // Restaurante no horário de Marabá. O módulo grava em UTC, e sem converter a
  // conta das 22h caía no dia seguinte, o sábado à noite contava como domingo e
  // o pico saía três horas adiantado. As comandas têm valores distintos para a
  // soma denunciar o dia errado. Confere também a cor do CMV% nas duas tabelas,
  // que o `td { color: !important }` do app-modern.css apagava.
  ['134. restaurante no fuso de Maraba (test-restaurante-fuso)', 'test-restaurante-fuso.js'],
  // Engenharia de cardápio por categoria. Com a média do cardápio inteiro a
  // bebida puxava a popularidade e todo prato virava "enigma". O cenário é
  // montado para as duas regras discordarem: pela média geral a suíte reprova.
  ['135. engenharia de cardapio por categoria (test-restaurante-engenharia)', 'test-restaurante-engenharia.js'],
];
// ==================== modo rápido: quais suítes ====================
/**
 * Mudança num destes arquivos pode quebrar qualquer tela ou rota, e nenhuma
 * busca por nome acha isso. O modo rápido não vale para eles: a rodada vira
 * inteira sozinha, e diz por quê.
 */
const OBRIGA_INTEIRO = [
  /^db-schema\.js$/, /^route-registry\.js$/, /^perfis-(acesso|api-map)\.js$/, /^role-dispatch\.js$/,
  /^(server|auth|auth-[a-z-]+|base-middleware|pre-auth-routes|tenant-[a-z-]+|plan-modules|module-gate)\.js$/,
  /^public\/js\/(menu-config|sidebar)\.js$/, /^public\/app\.(html|js)$/, /^public\/css\/app-modern\.css$/,
  /^public\/auth\/sw\.js$/, /^scripts\/(verify|banco-de-teste|guarda-dados|schema-de-tenant)\.js$/,
  /^package(-lock)?\.json$/,
];
const fonteDe = new Map(); // cache do fonte de cada suíte
const fonteSuite = (arq) => {
  if (!fonteDe.has(arq)) {
    const p = path.join(__dirname, arq);
    fonteDe.set(arq, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  }
  return fonteDe.get(arq);
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Suítes cujo fonte cita o arquivo (require, caminho de tela, readFileSync). */
function suitesDoArquivo(rel) {
  const semExt = rel.replace(/\.(js|html|css)$/, '');
  const base = path.basename(rel), baseSemExt = path.basename(semExt);
  const padroes = [new RegExp(`[/'"\`]${esc(rel.replace(/^public\//, ''))}['"\`?#)]`)];
  // Nome curto demais casaria em qualquer lugar ("app", "index"): esses só pelo caminho.
  if (baseSemExt.length >= 6 && !/^index$/.test(baseSemExt)) {
    padroes.push(new RegExp(`[/'"\`]${esc(baseSemExt)}(\\.(js|html|css))?['"\`?#)]`));
  }
  return suites.filter(([, arq]) => padroes.some((re) => re.test(fonteSuite(arq)))).map(([, arq]) => arq);
}

let selecionadas = suites;
if (OPC.rapido) {
  let alterados = ARQS_RAPIDO.map((a) => path.relative(RAIZ, path.resolve(a)));
  if (!alterados.length) {
    alterados = (git('status', '--porcelain', '--untracked-files=all') || '').split('\n').filter(Boolean)
      .filter((l) => !/^( D|D )/.test(l)).map((l) => l.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''));
  }
  const inteiro = alterados.filter((a) => OBRIGA_INTEIRO.some((re) => re.test(a)));
  if (inteiro.length) {
    console.log(`\n  modo rápido recusado: ${inteiro.slice(0, 5).join(', ')}${inteiro.length > 5 ? '…' : ''} `
      + 'é compartilhado por todas as telas. Rodando o verify inteiro.\n');
    RESULTADO.modo = 'inteiro (rapido recusado)';
  } else {
    const escolhidas = new Set(), semSuite = [];
    for (const a of alterados) {
      if (!/\.(js|html|css)$/.test(a)) continue; // doc, script de shell, planilha: só a sintaxe acima
      const propria = suites.find(([, arq]) => `scripts/${arq}` === a);
      const achadas = propria ? [propria[1]] : suitesDoArquivo(a);
      if (!achadas.length) semSuite.push(a);
      achadas.forEach((s) => escolhidas.add(s));
    }
    selecionadas = suites.filter(([, arq]) => escolhidas.has(arq));
    console.log(`\n  modo rápido: ${alterados.length} arquivo(s) alterado(s), ${selecionadas.length} suíte(s) ligada(s)`);
    if (semSuite.length) console.log(`  sem suíte nenhuma (só a sintaxe cobre): ${semSuite.join(', ')}`);
    console.log('');
    RESULTADO.semSuite = semSuite;
  }
  RESULTADO.alterados = alterados;
}

// ==================== execução ====================
// Cada suíte roda com a guarda de dados: abrir banco de data/ para escrita, ou
// gravar arquivo lá, reprova na hora e nomeia a suíte (ver guarda-dados.js).
const GUARDA = path.join(__dirname, 'guarda-dados.js');
const ENV_SUITE = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${GUARDA}`.trim() };
// Hang vira falha com nome, em vez de uma rodada que nunca termina. A mais
// lenta medida (fase51) levou 13,5 min com a máquina carregada.
const PRAZO_SUITE_MS = 30 * 60 * 1000;

function rodarSuite(rotulo, arq) {
  return new Promise((resolve) => {
    const r = { rotulo, arq, ms: 0, ok: false, resumo: '', falhas: [] };
    const p = path.join(__dirname, arq);
    if (!fs.existsSync(p)) { r.resumo = 'AUSENTE'; r.falhas.push(`${arq} não existe`); return resolve(r); }
    const ini = Date.now();
    let out = '', errOut = '', estourou = false;
    const filho = spawn(process.execPath, [p], { env: ENV_SUITE, cwd: RAIZ, stdio: ['ignore', 'pipe', 'pipe'] });
    filhos.add(filho);
    filho.stdout.on('data', (d) => { out += d; });
    filho.stderr.on('data', (d) => { errOut += d; });
    const prazo = setTimeout(() => { estourou = true; filho.kill('SIGKILL'); }, PRAZO_SUITE_MS);
    filho.on('close', (codigo, sinal) => {
      clearTimeout(prazo); filhos.delete(filho);
      r.ms = Date.now() - ini;
      r.resumo = (out.trim().split('\n').pop() || 'OK').trim();
      if (codigo === 0) { r.ok = true; return resolve(r); }
      const saida = out + '\n' + errOut;
      r.falhas = saida.split('\n').filter((l) => /FALHA/.test(l)).slice(0, 6).map((l) => l.trim());
      if (estourou) r.falhas.push(`${arq}: passou do prazo de ${PRAZO_SUITE_MS / 60000} min`);
      else if (!r.falhas.length) {
        // Sem linha de FALHA, o motivo costuma estar no fim do stderr (exceção, timeout do Chrome).
        const cauda = errOut.trim().split('\n').filter(Boolean).slice(-3).map((l) => l.trim().slice(0, 160)).join(' | ');
        r.falhas.push(`${arq}: saiu com ${sinal || 'código ' + codigo}${cauda ? ' — ' + cauda : ''}`);
      }
      resolve(r);
    });
    filho.on('error', (e) => { clearTimeout(prazo); filhos.delete(filho); r.falhas.push(`${arq}: ${e.message}`); resolve(r); });
  });
}

/** No sequencial o rótulo já saiu antes da suíte rodar; no paralelo, sai aqui. */
function registrar(r, emParalelo) {
  const conhecida = FALHAS_CONHECIDAS[r.arq];
  if (emParalelo) process.stdout.write(('  ' + r.rotulo).padEnd(50));
  etapaAtual = r.rotulo;
  console.log(r.ok ? `${r.resumo}${emParalelo ? ` (${Math.round(r.ms / 1000)}s)` : ''}`
    : (r.resumo === 'AUSENTE' ? 'AUSENTE' : `${conhecida ? '(falha conhecida) ' : ''}`));
  for (const f of r.falhas) falhar(f, r.arq);
  if (!r.ok && conhecida) console.error(`         conhecida: ${conhecida}`);
  RESULTADO.etapas.push({ rotulo: r.rotulo, arquivo: r.arq, segundos: Math.round(r.ms / 100) / 10, ok: r.ok });
  gravarJson();
}

/**
 * Grupos para o paralelo: suítes que citam o mesmo arquivo fixo de /tmp ou a
 * mesma porta fixa rodam em sequência, no mesmo trabalhador. Em 25/09 eram
 * quatro grupos por /tmp (o maior, seis suítes em /tmp/app-backend-schema.sql)
 * e nenhuma porta repetida. Descoberto no fonte a cada rodada, e não numa lista
 * à mão, para que suíte nova não precise lembrar de se declarar.
 */
function agrupar(lista) {
  const pai = lista.map((_, i) => i);
  const raiz = (i) => (pai[i] === i ? i : (pai[i] = raiz(pai[i])));
  const dono = new Map();
  lista.forEach(([, arq], i) => {
    const src = fonteSuite(arq);
    const fichas = [...src.matchAll(/'(\/tmp\/[A-Za-z0-9._-]+)'/g)].map((m) => m[1])
      .concat([...src.matchAll(/\.listen\(\s*(\d{3,5})/g)].map((m) => 'porta:' + m[1]));
    for (const f of fichas) {
      if (dono.has(f)) pai[raiz(i)] = raiz(dono.get(f)); else dono.set(f, i);
    }
  });
  const grupos = new Map();
  lista.forEach((s, i) => { const r = raiz(i); if (!grupos.has(r)) grupos.set(r, []); grupos.get(r).push(s); });
  return [...grupos.values()];
}

async function rodarTodas(lista) {
  if (OPC.paralelo <= 1) {
    for (const [rotulo, arq] of lista) { passo(rotulo); registrar(await rodarSuite(rotulo, arq), false); }
    return;
  }
  // Mais longo primeiro, pelos tempos da rodada anterior: o que decide a duração
  // total é a suíte mais longa começar cedo, e não no fim da fila.
  const tempo = new Map();
  try {
    for (const e of JSON.parse(fs.readFileSync(OPC.tempos, 'utf8')).etapas || []) tempo.set(e.arquivo, e.segundos || 0);
  } catch (_) { /* sem rodada anterior: ordem declarada */ }
  const fila = agrupar(lista).map((g) => ({ g, peso: g.reduce((s, [, a]) => s + (tempo.get(a) || 0), 0) }))
    .sort((a, b) => b.peso - a.peso).map((x) => x.g);
  console.log(`  ${lista.length} suítes em ${fila.length} grupos, ${OPC.paralelo} por vez\n`);
  const trabalhador = async () => {
    for (let g = fila.shift(); g; g = fila.shift()) {
      for (const [rotulo, arq] of g) registrar(await rodarSuite(rotulo, arq), true);
    }
  };
  await Promise.all(Array.from({ length: OPC.paralelo }, trabalhador));
}

(async () => {
  await rodarTodas(selecionadas);

  // ==================== resultado ====================
  const ms = Date.now() - t0;
  const conhecidas = RESULTADO.falhas.filter((f) => f.conhecida).length;
  RESULTADO.estado = 'concluido';
  RESULTADO.fim = new Date().toISOString();
  RESULTADO.segundos = Math.round(ms / 100) / 10;
  RESULTADO.totalFalhas = erros;
  RESULTADO.falhasNovas = erros - conhecidas;
  RESULTADO.codigo = erros ? 1 : 0;
  gravarJson();
  console.log('');
  if (erros) {
    console.error(`FALHOU: ${erros} problema(s) em ${(ms / 1000).toFixed(1)}s`
      + (conhecidas ? ` (${conhecidas} conhecida(s), ${erros - conhecidas} nova(s))` : ''));
    process.exit(1);
  }
  console.log(`OK: sintaxe válida — raiz, scripts/, public/, telas e shell (${(ms / 1000).toFixed(1)}s)`);
})();
