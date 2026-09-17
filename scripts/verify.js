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
 * isso contradizia a lista logo abaixo: das 29 etapas, 3 são de sintaxe e 26
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
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const t0 = Date.now();
let erros = 0;

const falhar = (msg) => { console.error('  FALHA  ' + msg); erros++; };
const passo = (txt) => process.stdout.write(('  ' + txt).padEnd(50));

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
];
for (const [rotulo, arq] of suites) {
  passo(rotulo);
  const p = path.join(__dirname, arq);
  if (!fs.existsSync(p)) { console.log('AUSENTE'); falhar(`${arq} não existe`); continue; }
  try {
    const saida = execFileSync(process.execPath, [p], { encoding: 'utf8', stdio: 'pipe' });
    console.log((saida.trim().split('\n').pop() || 'OK').trim());
  } catch (e) {
    console.log('');
    const saida = (e.stdout || '') + (e.stderr || '');
    saida.split('\n').filter((l) => /FALHA/.test(l)).slice(0, 6).forEach((l) => falhar(l.trim()));
    if (!/FALHA/.test(saida)) falhar(`${arq}: ${(e.message || '').split('\n')[0]}`);
  }
}

// ==================== resultado ====================
const ms = Date.now() - t0;
console.log('');
if (erros) {
  console.error(`FALHOU: ${erros} problema(s) em ${(ms / 1000).toFixed(1)}s`);
  process.exit(1);
}
console.log(`OK: sintaxe válida — raiz, scripts/, public/, telas e shell (${(ms / 1000).toFixed(1)}s)`);
