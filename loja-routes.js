/**
 * loja-routes.js — vitrine pública do cliente (módulo Varejo).
 *
 * Fase 1: catálogo somente leitura. O lojista escolhe o que publicar, ajusta
 * marca e cores, e recebe o contato pelo WhatsApp com o item já preenchido.
 * Não há carrinho, login de comprador nem pagamento — isso é fase 2, e o
 * pedido nascerá pela API de pedidos que o ERP já usa.
 *
 * A vitrine lê o MESMO catálogo que abastece o Mercado Livre: os mesmos
 * produtos, as mesmas fotos de produto_imagens. Publicar aqui não interfere
 * em anúncio nenhum — são duas saídas do mesmo dado.
 *
 * Duas famílias de rota, e a separação é de segurança, não de organização:
 *   - registrarRotasLojaPublica  -> pre-auth-routes, SEM login. Só devolve
 *     produto publicado e ativo, e nunca custo, margem ou fornecedor.
 *   - registrarRotasLojaAdmin    -> route-registry, atrás da barreira.
 */

const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const imgs = require('./produto-imagens');
const { requirePortalAuth } = require('./portal-routes');
const { resolverPreco, precoPromocional } = require('./precos-routes');
const { gerarNumero, recalcularTotal, confirmarPedidoInterno } = require('./pedidos-routes');
const { resolverDeposito } = require('./estoque-routes');
const { reentrarContextoTenant } = require('./tenant-middleware');
const { criarReservasPedido } = require('./reservas-routes');
const semDoc = require('./pessoa-sem-documento');
const montagem = require('./loja-montagem');
const pagamentoLoja = require('./loja-pagamento');

const RAIZ_PUBLICA = path.join(__dirname, 'public');
const SUBDIR_LOJA = 'uploads/loja';

// Tema padrão. Poucos valores, todos viram variável CSS na página — o lojista
// escolhe valores, o layout continua sendo nosso.
const TEMA_PADRAO = {
  preset: 'neutro',
  corPrimaria: '#0E6B63',
  fundo: 'claro',        // claro | suave | escuro
  fonte: 'neutra',       // neutra | tecnica | editorial | amigavel
  raio: 10,
  /* Vitrine decorada (2026-09-27). Todos opcionais: sem eles a loja fica
     exatamente como era. `corSecundaria` pinta selos, ofertas e a faixa;
     `corTema` é a cor da barra do navegador no celular (meta theme-color);
     `fonteTitulo` troca só a família dos títulos, e 'igual' usa a do texto;
     `faixaTexto` é a faixa de aviso no topo da página. */
  corSecundaria: null,
  corTema: null,
  fonteTitulo: 'igual',  // igual | elegante | classica | serifa | manuscrita | moderna
  faixaTexto: null,
  /* Vitrine com acabamento (2026-09-28), para chegar ao visual de um
     protótipo de cliente sem CSS livre. Todos opcionais, e os padrões deixam
     a loja exatamente como era: `corFundo` troca a cor da página; `corApoio`
     é a terceira cor (o segundo brilho do fundo aquarela); `fundoEfeito`
     'aquarela' desenha dois brilhos suaves nas cores secundária e de apoio;
     `sombra` dá profundidade a cards e botões; `topo` 'translucido' deixa a
     barra do topo sem fundo branco nem linha, e 'degrade' (29/09) tira a
     caixa de vez: o fundo e o desfoque somem até a base; `sigla` é o círculo com as
     iniciais quando não há logo; `slogan` é a linha curta em caixa alta sob o
     nome; `destaque` é o bloco do topo da vitrine, com a capa como imagem. */
  corFundo: null,
  corApoio: null,
  fundoEfeito: 'liso',   // liso | aquarela
  sombra: 'nenhuma',     // nenhuma | suave | profunda
  topo: 'solido',        // solido | translucido | degrade
  sigla: null,
  slogan: null,
  destaque: null,        // { ativo, selo, titulo, texto, botao, botaoWhatsapp, etiqueta }
};

/* Valores aceitos de cada escolha do tema. A validação do PUT e a tela do
   lojista leem daqui, para que uma opção nova não precise ser escrita duas
   vezes. */
const OPCOES_TEMA = {
  fundo: ['claro', 'suave', 'escuro'],
  fonte: ['neutra', 'tecnica', 'editorial', 'amigavel'],
  fonteTitulo: ['igual', 'elegante', 'classica', 'serifa', 'manuscrita', 'moderna'],
  fundoEfeito: ['liso', 'aquarela'],
  sombra: ['nenhuma', 'suave', 'profunda'],
  topo: ['solido', 'translucido', 'degrade'],
};

/* Textos do destaque do topo, com o limite de cada um. Texto a mais é
   cortado, e não recusado: quem cola um parágrafo longo quer ver o começo
   dele, não uma mensagem de erro. */
const LIMITES_DESTAQUE = { selo: 40, titulo: 90, texto: 280, botao: 30, botaoWhatsapp: 30, etiqueta: 30 };
function lerDestaque(bruto) {
  if (!bruto || typeof bruto !== 'object') return null;
  const d = { ativo: !!bruto.ativo };
  for (const [campo, max] of Object.entries(LIMITES_DESTAQUE)) {
    d[campo] = bruto[campo] == null ? null : String(bruto[campo]).trim().slice(0, max) || null;
  }
  return d;
}

const PRESETS = {
  neutro:     { corPrimaria: '#0E6B63', fundo: 'claro',  fonte: 'neutra',    raio: 10 },
  industrial: { corPrimaria: '#B4531A', fundo: 'escuro', fonte: 'tecnica',   raio: 4 },
  vivo:       { corPrimaria: '#1D4ED8', fundo: 'claro',  fonte: 'editorial', raio: 16 },
};

const alterSafe = (db, sql) => {
  try { db.exec(sql); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
};

/**
 * Nome de arquivo de imagem da loja, carimbado com o tenant.
 *
 * `uploads/loja` é pasta ÚNICA para todos os tenants — é o padrão de todas as
 * pastas de upload deste projeto, e mudar isso agora quebraria os `logoPath` já
 * gravados. O que dá para garantir sem migrar nada é que dois tenants nunca
 * disputem o mesmo nome: só `Date.now()` colide se dois uploads caírem no mesmo
 * milissegundo, e aí um tenant sobrescreve a imagem do outro.
 *
 * Slug + tempo + 6 bytes aleatórios tornam isso impossível na prática, e o nome
 * passa a dizer de quem é o arquivo — o que importa na hora de auditar a pasta.
 */
function nomeImagemLoja(req, prefixo, ext) {
  const slug = String(req.tenant?.slug || 'sem-tenant').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  return `${prefixo}-${slug}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
}

// Modos de cobrança. 'nenhum' mantém o comportamento B2B: o pedido vai para
// conferência e a cobrança sai pela régua do financeiro, como sempre.
const MODOS_PAGAMENTO = ['nenhum', 'pix', 'boleto', 'pix-ou-boleto'];

/**
 * Colunas de "Informações da empresa" no catálogo.
 *
 * Declaradas num lugar só porque precisam ser aplicadas em DOIS caminhos — o
 * `db-schema.js` (tenant que já existe) e o `migrarLojaDB` (tenant novo, onde
 * `loja_config` acaba de nascer). Duas listas divergiriam no primeiro descuido.
 *
 * `endereco` é TEXTO LIVRE e OPCIONAL: o endereço fiscal já vive em
 * `fornecedor`, e é dele que a vitrine se serve quando este está vazio. A
 * coluna existe para o caso em que o ponto de atendimento não é o endereço do
 * CNPJ — loja de rua com matriz em outro lugar.
 *
 * `mostrarEndereco` nasce 0: endereço de quem vende em casa não vai ao ar sem
 * alguém dizer que pode.
 *
 * `horarios` é JSON, e não tabela, porque são no máximo 7 linhas lidas sempre
 * juntas e nunca consultadas por SQL. O formato guarda uma LISTA de faixas por
 * dia — `{"1":[["08:00","12:00"],["14:00","18:00"]]}` —, então o segundo período
 * que a fase seguinte pode pedir já cabe aqui sem migration nova.
 */
const COLUNAS_INFO_LOJA = [
  'endereco TEXT',
  'mostrarEndereco INTEGER NOT NULL DEFAULT 0',
  'horarios TEXT',

  /* ── Entrega e cobertura (Fase 52) ──────────────────────────────────────
   *
   * `servicoRetirada` nasce LIGADO e `servicoDelivery` DESLIGADO: retirada é o
   * que toda loja consegue fazer no dia em que publica o catálogo; entrega
   * pressupõe alguém para entregar. Ligar delivery por padrão prometeria ao
   * consumidor um serviço que ninguém combinou.
   *
   * `freteModo` vale 'gratis', 'fixo', 'bairro' ou 'combinar' (MODOS_FRETE). Cálculo
   * por quilômetro, polígono e faixa de distância ficaram de fora por decisão —
   * exigem mapa, e o combinado é uma solução simples antes de uma cara.
   *
   * `freteValor` só é lido quando o modo é 'fixo'. No modo 'bairro' o valor vem
   * de `rest_bairros_taxa`, linha a linha. */
  "servicoRetirada INTEGER NOT NULL DEFAULT 1",
  "servicoDelivery INTEGER NOT NULL DEFAULT 0",
  "freteModo TEXT NOT NULL DEFAULT 'gratis'",
  'freteValor REAL NOT NULL DEFAULT 0',
  'aceitaForaCobertura INTEGER NOT NULL DEFAULT 0',

  /* ── Enquadramento das imagens (Fase 52) ────────────────────────────────
   *
   * Guarda o AJUSTE, não a imagem recortada. JSON `{"x":50,"y":30,"zoom":1.4}`,
   * com x/y em porcentagem do quadro e zoom >= 1.
   *
   * Recortar e salvar o recorte seria mais simples e está errado por dois
   * motivos: a imagem seria re-encodada a cada reajuste, degradando um pouco
   * mais toda vez, e o original se perderia — reenquadrar depois partiria de
   * uma imagem já cortada. Guardando só o ajuste, o arquivo enviado fica
   * intocado e a exibição o aplica por CSS (`object-position` + `scale`). */
  'logoFoco TEXT',
  'bannerFoco TEXT',

  /* ── Regras fiscais do catálogo (Fase 1 fiscal, 2026-09-21) ───────────────
   *
   * Duas REFERÊNCIAS a `tipos_operacao`, e nada além disso. `emiteNFe`,
   * `geraFinanceiro`, `movimentaEstoque`, CFOP, finalidade e impostos NÃO são
   * copiados para cá: a natureza escolhida continua sendo a fonte única, e o
   * motor do ERP continua decidindo os efeitos. Copiar qualquer um desses
   * campos criaria uma segunda verdade que envelheceria sozinha no dia em que
   * o lojista editasse a natureza.
   *
   * `tipoOperacaoPedidoId` é a natureza com que o pedido do catálogo NASCE.
   * Até 2026-09-20 ele nascia com `tipoOperacaoId` NULL, e três decisões
   * fiscais eram tomadas por fallback fail-open — gerar financeiro, ser
   * fiscal e movimentar estoque, todas por omissão. Funcionava por acidente,
   * não por escolha.
   *
   * `tipoOperacaoNfceId` é a natureza da NFC-e originada de pedido do
   * catálogo. Ela é CONFIGURÁVEL nesta fase e ainda não é USADA: nenhum
   * endpoint do catálogo emite NFC-e, porque delivery e cancelamento ainda
   * não estão resolvidos. Ela existe aqui para que a Fase 2 não precise
   * mexer em schema.
   *
   * Nenhuma das duas é preenchida automaticamente, e nenhum pedido antigo é
   * adotado retroativamente. */
  'tipoOperacaoPedidoId INTEGER',
  'tipoOperacaoNfceId INTEGER',

  /* ── Vitrine com a cara da loja (2026-09-27) ────────────────────────────
   *
   * `faviconPath` é o ícone da aba, enviado pelo lojista; sem ele a vitrine
   * segue com o ícone vazio, e nunca com o do ERP.
   *
   * `rodapeTexto` substitui o "© ano nome" do rodapé quando preenchido.
   *
   * `paginaInicial` faz o endereço do tenant abrir a loja: o visitante que
   * chega em `/` vai para `/loja/`, e caminho desconhecido recebe o 404 da
   * loja em vez do login do ERP. Nasce 0, porque trocar a porta de entrada
   * de quem já usa o ERP pelo endereço raiz não pode acontecer sozinho. */
  'faviconPath TEXT',
  'rodapeTexto TEXT',
  'paginaInicial INTEGER NOT NULL DEFAULT 0',
];

/**
 * Enquadramento salvo, saneado para virar CSS.
 *
 * Entrada não confiável como qualquer outra: x/y presos a 0–100 e zoom a 1–4.
 * Fora disso a imagem sairia do quadro ou ficaria ilegível de tão ampliada.
 */
function lerFoco(bruto) {
  let o;
  try { o = typeof bruto === 'string' ? JSON.parse(bruto || 'null') : bruto; }
  catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const preso = (v, min, max, padrao) => {
    /* `null` e `''` precisam cair no PADRÃO, não em zero: `Number(null)` é 0 e
       passa por `isFinite`, o que fazia `{y: null}` virar y=0 — a imagem
       encostada no topo em vez de centrada. */
    if (v == null || v === '') return padrao;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao;
  };
  return {
    x: preso(o.x, 0, 100, 50),
    y: preso(o.y, 0, 100, 50),
    zoom: Math.round(preso(o.zoom, 1, 4, 1) * 100) / 100,
  };
}

/** Os modos de frete. Fora disto, o servidor recusa. Em 'combinar' a entrega
 *  entra sem taxa, e a loja a lança depois na tela do pedido. */
const MODOS_FRETE = ['gratis', 'fixo', 'bairro', 'combinar'];

function migrarLojaDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loja_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ativa INTEGER NOT NULL DEFAULT 0,
      nome TEXT,
      descricao TEXT,
      logoPath TEXT,
      whatsapp TEXT,
      email TEXT,
      telefone TEXT,
      mostrarPreco INTEGER NOT NULL DEFAULT 0,
      mostrarEstoque INTEGER NOT NULL DEFAULT 1,
      tema TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Cobrança no checkout é opt-in e por loja: em B2B o normal é o lojista
  // conferir antes de cobrar; em venda avulsa, cobrar na hora é o que fecha.
  alterSafe(db, "ALTER TABLE loja_config ADD COLUMN pagamentoModo TEXT DEFAULT 'nenhum'");
  alterSafe(db, 'ALTER TABLE loja_config ADD COLUMN pagamentoVencimentoDias INTEGER DEFAULT 3');
  // Banner do cabeçalho da vitrine. O par deste ALTER está em db-schema.js, que
  // é quem alcança tenant já existente; este aqui cobre o tenant novo.
  alterSafe(db, 'ALTER TABLE loja_config ADD COLUMN bannerPath TEXT');
  // Redes sociais do catálogo público. Mesmo par de ALTERs do bannerPath, e pelo
  // mesmo motivo: o db-schema.js alcança tenant existente, este aqui alcança o
  // tenant novo, onde `loja_config` só passa a existir na linha acima.
  alterSafe(db, 'ALTER TABLE loja_config ADD COLUMN instagram TEXT');
  alterSafe(db, 'ALTER TABLE loja_config ADD COLUMN facebook TEXT');
  // Endereço e horários do catálogo (Fase 51). Mesmo par de ALTERs: aqui alcança
  // o tenant novo, no db-schema.js alcança quem já existe.
  for (const c of COLUNAS_INFO_LOJA) alterSafe(db, `ALTER TABLE loja_config ADD COLUMN ${c}`);
  db.prepare('INSERT OR IGNORE INTO loja_config (id, tema) VALUES (1, ?)')
    .run(JSON.stringify(TEMA_PADRAO));
  // Publicar é opt-in: catálogo inteiro no ar por engano é vazamento de
  // preço e de linha de produto.
  try { db.exec('ALTER TABLE produtos ADD COLUMN publicadoNaLoja INTEGER DEFAULT 0'); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

  /* Destaque da vitrine.
   *
   * Uma COLUNA, e não uma categoria chamada "Destaques": destaque é ortogonal
   * à categoria. Um produto continua em "Cestas de café da manhã" E aparece em
   * Destaques — se fosse categoria, ou ele saía da sua, ou teria de existir
   * duas vezes. Nenhuma das duas serve.
   *
   * Aditiva, com default 0: nenhuma linha é reescrita e todo produto nasce
   * fora dos destaques. */
  alterSafe(db, 'ALTER TABLE produtos ADD COLUMN destaqueNaLoja INTEGER DEFAULT 0');

  // Carrinho no servidor, não no navegador: o comprador monta no celular e
  // fecha no computador, e o lojista consegue ver carrinho abandonado.
  db.exec(`
    CREATE TABLE IF NOT EXISTS loja_carrinho (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pessoaId INTEGER NOT NULL,
      produtoId INTEGER NOT NULL,
      quantidade REAL NOT NULL DEFAULT 1,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pessoaId, produtoId)
    );
    CREATE INDEX IF NOT EXISTS idx_loja_carrinho_pessoa ON loja_carrinho(pessoaId);
  `);
  // Marca a origem sem mexer em `tipo`, que já tem consumidores esperando
  // 'manual' e 'licitacao'.
  try { db.exec('ALTER TABLE pedidos ADD COLUMN origemLoja INTEGER DEFAULT 0'); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

const jsonOu = (t, padrao) => { try { return t ? JSON.parse(t) : padrao; } catch { return padrao; } };

function lerConfig(db) {
  const c = db.prepare('SELECT * FROM loja_config WHERE id = 1').get() || {};
  return { ...c, tema: { ...TEMA_PADRAO, ...jsonOu(c.tema, {}) } };
}

const r2c = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Identificador de rede social, saneado para virar URL.
 *
 * Guarda-se o USUÁRIO, não a URL — e é aqui que isso se faz valer. Aceitar
 * endereço completo abriria a porta para `javascript:alert(1)` e para
 * `instagram.com.evil.io/loja`: o primeiro executa script na página do lojista,
 * o segundo manda o cliente dele para outro domínio.
 *
 * A regra é de lista branca, não de lista negra: sobra só o que casa com
 * `[A-Za-z0-9._-]`. Se o lojista colar a URL inteira, o prefixo conhecido é
 * removido e o resto aproveitado — colar o link é o que as pessoas fazem, e
 * recusar por isso seria pedantismo.
 */
function usuarioRede(valor, dominio) {
  let v = String(valor == null ? '' : valor).trim();
  if (!v) return null;
  /* Protocolo perigoso some antes de qualquer outra coisa.
   *
   * REDUNDANTE de propósito, e vale dizer por quê: a lista branca lá embaixo já
   * barra `javascript:alert(1)` sozinha — `:` e `(` não estão nos caracteres
   * aceitos. A sabotagem de 14/09 confirmou isso: remover esta linha não abriu
   * buraco nenhum.
   *
   * Ela fica porque a lista branca é o tipo de regra que alguém afrouxa no
   * futuro para aceitar um caractere novo, e nesse dia esta linha é a que
   * continua de pé. Uma linha é barato demais para trocar por essa aposta. */
  if (/^\s*(javascript|data|vbscript|file):/i.test(v)) return null;
  v = v.replace(/^https?:\/\//i, '')
       .replace(new RegExp('^(www\\.)?' + dominio.replace('.', '\\.') + '/', 'i'), '')
       .replace(/^@/, '')
       .split(/[/?#]/)[0]
       .trim();
  if (!v) return null;
  // Lista branca: nome de usuário é isto, e nada mais.
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(v)) return null;
  /* Ainda parece domínio depois de tirar o prefixo? Então era outro domínio.
   *
   * `instagram.com.evil.io/loja` sobrevive à lista branca — ponto e hífen são
   * legítimos num nome de usuário. O link montado continuaria seguro, porque o
   * domínio é fixo aqui e o path foi cortado; o problema é outro: isso é erro
   * de digitação, e publicá-lo como perfil manda o cliente do lojista para uma
   * página que não existe. */
  if (/\.(com|net|org|io|br|co|me|app|link|bio)\b/i.test(v)) return null;
  return v;
}

/** Só dígitos: é o que o wa.me aceita. Máscara e sinais viram link quebrado. */
function whatsappNormalizado(valor) {
  const d = String(valor == null ? '' : valor).replace(/\D/g, '');
  if (d.length < 10 || d.length > 15) return null;
  // Número brasileiro sem DDI ganha o 55 — senão o wa.me abre uma conversa vazia.
  return d.length <= 11 ? '55' + d : d;
}

/**
 * O cadastro geral da empresa, do jeito que a vitrine precisa.
 *
 * É a FONTE DE FALLBACK — nunca a fonte preferida. A regra, em uma linha: o que
 * o lojista configurou no Catálogo Online vence; faltando, usa-se o que o
 * emitente já tem. É o que evita duplicar nome, logo, telefone e endereço em
 * dois lugares e depois ter de mantê-los iguais.
 *
 * Só campos PÚBLICOS saem daqui: nada de CNPJ, inscrição, dados bancários ou
 * representante legal — o emitente guarda muita coisa que não é assunto de quem
 * está comprando.
 */
function empresaDe(db) {
  try {
    const f = db.prepare(`SELECT razaoSocial, nomeFantasia, logoBase64, telefone, celular,
        endereco, numero, bairro, cidade, uf, cep FROM fornecedor ORDER BY id DESC LIMIT 1`).get();
    if (!f) return {};
    const linha = [
      [f.endereco, f.numero].filter(Boolean).join(', '),
      f.bairro,
      [f.cidade, f.uf].filter(Boolean).join('/'),
    ].filter(Boolean).join(' · ');
    return {
      nome: (f.nomeFantasia || '').trim() || (f.razaoSocial || '').trim() || null,
      logo: f.logoBase64 || null,
      telefone: (f.telefone || '').trim() || (f.celular || '').trim() || null,
      endereco: linha || null,
    };
  } catch { return {}; }
}

/**
 * Cobertura de entrega: os bairros atendidos e suas taxas.
 *
 * Lê `rest_bairros_taxa`, que NASCEU no módulo Restaurante mas é tabela de
 * DEFINIÇÃO pura — `id, nome, taxa, tempoEstimadoMin, ativo`, sem chave
 * estrangeira para `rest_comandas`. A partir da Fase 52 ela é **configuração
 * compartilhada de cobertura**, usada também pelo Catálogo Online.
 *
 * O que continua separado, e precisa continuar: o PEDIDO. `rest_entregas` é que
 * amarra a comanda, e o catálogo comercial não a toca — o pedido do catálogo
 * termina em `pedidos`, como sempre.
 *
 * `somenteAtivos` existe porque o público só pode ver o que está no ar, e a
 * tela administrativa precisa ver tudo para poder reativar.
 */
function bairrosCobertura(db, { somenteAtivos = true } = {}) {
  try {
    const sql = `SELECT id, nome, taxa, tempoEstimadoMin, ativo FROM rest_bairros_taxa
      ${somenteAtivos ? 'WHERE ativo = 1' : ''} ORDER BY nome COLLATE NOCASE`;
    return db.prepare(sql).all().map((b) => ({
      id: b.id, nome: b.nome, taxa: r2c(b.taxa),
      tempoEstimadoMin: Number(b.tempoEstimadoMin) || 0, ativo: !!b.ativo,
    }));
  } catch { return []; }
}

/**
 * Configuração de entrega como o PÚBLICO pode vê-la.
 *
 * Só o que o consumidor precisa para decidir: quais serviços existem, quanto
 * custa entregar e onde se entrega. Nada de modo interno de cálculo além do
 * necessário para exibir o valor.
 *
 * Quando `servicoDelivery` está desligado, a cobertura inteira some do payload:
 * publicar bairros de um serviço que não é oferecido só gera pergunta.
 */
/* ══════════════════════════════════════════════════════════════════════════
   CHECKOUT PÚBLICO — peças de entrada
   Só o que não depende do banco. A rota vive em `registrarRotasLojaPublica`.
   ══════════════════════════════════════════════════════════════════════════ */

/** Só dígitos, e nada de string gigante vinda do corpo. */
const soDigitos = (v, max) => String(v == null ? '' : v).replace(/\D/g, '').slice(0, max);

/** Texto de entrada: apara, colapsa espaço, limita, e null quando sobra nada. */
const txtPub = (v, max) => {
  const t = String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);
  return t || null;
};

/**
 * CPF/CNPJ com dígito verificador conferido.
 *
 * O ERP não tinha validador, e cadastrar documento inválido é pior que não
 * cadastrar: ele viaja até a NF-e e o erro aparece na SEFAZ com a venda já
 * feita. Quem não quer informar tem o caminho explícito do
 * `pessoa-sem-documento`; quem informa, informa certo.
 *
 * @returns {string|null} só os dígitos, ou null se não for válido.
 */
function documentoValido(bruto) {
  const d = soDigitos(bruto, 14);
  if (d.length === 11) {
    if (/^(\d)\1{10}$/.test(d)) return null;
    const dv = (base, peso) => {
      const soma = base.split('').reduce((acc, n, i) => acc + Number(n) * (peso - i), 0);
      const r = (soma * 10) % 11;
      return String(r === 10 ? 0 : r);
    };
    return dv(d.slice(0, 9), 10) === d[9] && dv(d.slice(0, 10), 11) === d[10] ? d : null;
  }
  if (d.length === 14) {
    if (/^(\d)\1{13}$/.test(d)) return null;
    const dv = (base) => {
      const pesos = base.length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      const soma = base.split('').reduce((acc, n, i) => acc + Number(n) * pesos[i], 0);
      const r = soma % 11;
      return String(r < 2 ? 0 : 11 - r);
    };
    return dv(d.slice(0, 12)) === d[12] && dv(d.slice(0, 13)) === d[13] ? d : null;
  }
  return null;
}

/**
 * A impressão digital da INTENÇÃO do checkout.
 *
 * Existe por causa de um caso só: a mesma chave de idempotência chegando com
 * um pedido DIFERENTE. Devolver calado o pedido antigo faria o cliente achar
 * que comprou o que acabou de montar; criar um segundo pedido derrubaria a
 * própria idempotência. A saída é recusar com 409 — e para recusar é preciso
 * saber que a intenção mudou.
 *
 * ── Por que NÃO precisa de coluna nova ──────────────────────────────────────
 *
 * Tudo o que compõe a impressão é gravado no pedido: cliente, atendimento,
 * meio de pagamento, total e a linha de cada item com a descrição já montada
 * (que carrega as personalizações). Então ela é RECALCULÁVEL a partir do
 * pedido, e comparar não exige guardar hash nenhum.
 *
 * Comparar só total, cliente e contagem de itens seria fraco: trocar um
 * produto por outro de mesmo preço passaria batido. Aqui entram os ids, as
 * quantidades e a descrição de cada item, em ordem estável.
 */
function impressaoDaIntencao(d) {
  const partes = [
    'n=' + (d.nome || ''),
    't=' + (d.telefone || ''),
    'doc=' + (d.documento || ''),
    'at=' + (d.atendimento || ''),
    'pg=' + (d.pagamento || ''),
    'tot=' + Number(d.total || 0).toFixed(2),
    ...[...d.itens]
      .map((i) => `${i.produtoId}x${i.quantidade}:${i.descricao}`)
      .sort(),                     // ordem do carrinho não muda a intenção
  ];
  return crypto.createHash('sha256').update(partes.join('|')).digest('hex');
}

/** Hoje em Brasília, no mesmo critério do resto do ERP (UTC-3, sem timezone por tenant). */
function dataDeHojeBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * A natureza com que o pedido do catálogo nasce — ou null se não dá para saber.
 *
 * Devolve a LINHA de `tipos_operacao`, e não o id, porque quem chama precisa
 * saber o que ela decide antes de criar qualquer coisa.
 *
 * Três recusas, e todas devolvem null:
 *   - nada configurado;
 *   - configurado para uma natureza que não existe mais (alguém a removeu);
 *   - configurado para uma natureza inativa.
 *
 * O id vem do BANCO DO TENANT, então natureza de outra empresa não é
 * encontrada aqui — é o mesmo isolamento que vale para o resto do ERP, e não
 * depende de ninguém lembrar de checar o tenant.
 *
 * O que esta função NÃO faz, de propósito: julgar `emiteNFe`,
 * `geraFinanceiro` ou `movimentaEstoque`. Essas decisões são da natureza
 * escolhida, e é justamente por isso que o lojista a escolhe. Exigir aqui um
 * valor para qualquer uma delas seria trazer a regra para dentro do catálogo,
 * que é o oposto do que esta fase faz.
 */
function naturezaDoPedidoDoCatalogo(db, cfg) {
  const id = Number(cfg && cfg.tipoOperacaoPedidoId);
  if (!Number.isInteger(id) || id <= 0) return null;
  let nat;
  try { nat = db.prepare('SELECT * FROM tipos_operacao WHERE id = ?').get(id); }
  catch { return null; }   // tenant antigo, sem a tabela: cai na recusa de negócio
  if (!nat) return null;
  if (Number(nat.ativo) === 0) return null;
  return nat;
}

/** Os três meios desta fase, no vocabulário SEFAZ que o ERP já usa. */
const PAGAMENTOS_CHECKOUT = { pix: '17', dinheiro: '01', cartao: '03' };
const ROTULO_PAGAMENTO = { pix: 'PIX', dinheiro: 'Dinheiro', cartao: 'Cartão na entrega/retirada' };

/**
 * A descrição do item, com as personalizações que o SERVIDOR validou.
 *
 * `pedido_itens` não tem campo para opções, e criar um seria estrutura nova
 * para o que a descrição resolve — é ela que o separador lê e que sai no PDF.
 * O nome de cada opção vem de `rest_opcoes`, buscado por id; do cliente vem
 * só o campo livre, já limitado por `validarEscolhas`.
 */
function descricaoDoItem(item) {
  const partes = [item.descricao];
  for (const o of item.opcoes) partes.push(o.nome);
  if (item.textosNomeados) {
    for (const t of item.textosNomeados) if (t.texto) partes.push(`${t.nome}: ${t.texto}`);
  } else {
    for (const [rotulo, valor] of Object.entries(item.textos || {})) {
      if (valor) partes.push(`${rotulo}: ${valor}`);
    }
  }
  if (item.comentario) partes.push(`Obs.: ${item.comentario}`);
  // 600 cabe a montagem, os adicionais e a mensagem do cartão inteira. A NF-e
  // e a NFC-e cortam o xProd em 120 por conta própria.
  return partes.join(' · ').slice(0, 600);
}

/**
 * Grava as escolhas do item em `pedido_item_opcoes`, uma linha por opção e por
 * campo livre. Roda DEPOIS da validação (`validarEscolhas`): só chegam aqui
 * opções que pertencem ao produto.
 *
 * O insumo é lido da opção agora e copiado para a linha. É essa cópia que a
 * explosão do pedido (reservas-routes.explodirItensPedido) usa para reservar e
 * baixar a embalagem, a fita e o cartão, e ela não muda se o lojista trocar o
 * insumo da opção depois.
 */
function gravarEscolhasDoItem(db, pedidoId, pedidoItemId, item) {
  const insumoDe = db.prepare('SELECT insumoProdutoId, quantidadeInsumo FROM rest_opcoes WHERE id = ?');
  const nomeGrupo = db.prepare('SELECT nome FROM rest_grupos_opcao WHERE id = ?');
  const ins = db.prepare(`INSERT INTO pedido_item_opcoes
      (pedidoId, pedidoItemId, grupoId, grupoNome, opcaoId, nome, texto, precoAdicional, insumoProdutoId, quantidadeInsumo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const o of item.opcoes || []) {
    const ins0 = insumoDe.get(o.id) || {};
    const g = nomeGrupo.get(o.grupoId) || {};
    const temInsumo = ins0.insumoProdutoId && Number(ins0.quantidadeInsumo) > 0;
    ins.run(pedidoId, pedidoItemId, o.grupoId, g.nome || null, o.id, o.nome, null, r2c(o.precoAdicional),
      temInsumo ? ins0.insumoProdutoId : null, temInsumo ? Number(ins0.quantidadeInsumo) : null);
  }
  for (const [grupoId, texto] of Object.entries(item.textos || {})) {
    if (!texto) continue;
    const g = nomeGrupo.get(Number(grupoId)) || {};
    ins.run(pedidoId, pedidoItemId, Number(grupoId), g.nome || null, null, null, texto, 0, null, null);
  }
}

function entregaPublica(db, cfg) {
  const delivery = !!cfg.servicoDelivery;
  const modo = MODOS_FRETE.includes(cfg.freteModo) ? cfg.freteModo : 'gratis';
  const fora = {
    retirada: !!cfg.servicoRetirada,
    delivery,
    // Sem delivery não há frete a anunciar.
    freteModo: delivery ? modo : null,
    freteValor: delivery && modo === 'fixo' ? r2c(cfg.freteValor) : null,
    aceitaForaCobertura: delivery ? !!cfg.aceitaForaCobertura : false,
    bairros: [],
  };
  if (delivery && modo === 'bairro') {
    fora.bairros = bairrosCobertura(db).map((b) => ({ nome: b.nome, taxa: b.taxa }));
  }
  return fora;
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const HORA_OK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Horários: JSON `{ "<0-6>": [["08:00","12:00"], ...] }`, domingo = 0.
 *
 * Saneado na LEITURA porque o que está no banco pode ter vindo de uma versão
 * anterior da tela, ou de um dia em que alguém editou à mão. Faixa malformada é
 * descartada, não corrigida: adivinhar "18:0" como "18:00" acabaria publicando
 * um horário que ninguém escolheu.
 */
function lerHorarios(bruto) {
  let o;
  try { o = typeof bruto === 'string' ? JSON.parse(bruto || '{}') : (bruto || {}); }
  catch { return {}; }
  if (!o || typeof o !== 'object') return {};
  const fora = {};
  for (let d = 0; d <= 6; d++) {
    const faixas = Array.isArray(o[d]) ? o[d] : (Array.isArray(o[String(d)]) ? o[String(d)] : []);
    const boas = [];
    for (const f of faixas) {
      if (!Array.isArray(f) || f.length !== 2) continue;
      const [i, fim] = [String(f[0] || '').trim(), String(f[1] || '').trim()];
      if (!HORA_OK.test(i) || !HORA_OK.test(fim)) continue;
      if (i >= fim) continue;                  // faixa que não fecha é faixa que não vale
      boas.push([i, fim]);
    }
    if (boas.length) fora[d] = boas.sort((a, b) => a[0].localeCompare(b[0]));
  }
  return fora;
}

/** Agora em Brasília. Mesmo critério de `dataBrasilia()` do resto do ERP. */
function agoraBrasilia() {
  const b = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return { diaSemana: b.getUTCDay(),
           hhmm: String(b.getUTCHours()).padStart(2, '0') + ':' + String(b.getUTCMinutes()).padStart(2, '0') };
}

/**
 * Está aberto agora? E, se não, quando abre?
 *
 * **Informativo, e só.** Nesta fase nada bloqueia carrinho ou pedido por causa
 * do horário — a tela conta o que está acontecendo, não impede nada.
 *
 * Sem horário configurado devolve `null`: um catálogo que nunca declarou
 * expediente não deve aparecer como "Fechado", que seria afirmar algo que o
 * lojista não disse.
 *
 * O fuso é o de Brasília para todos, porque é assim que o ERP inteiro trata
 * data (`dataBrasilia()`), e não existe timezone por tenant. Inventar um aqui
 * criaria a primeira noção divergente de "hoje" no sistema.
 */
function statusAtendimento(horarios, agora = agoraBrasilia()) {
  const h = lerHorarios(horarios);
  if (!Object.keys(h).length) return null;

  const { diaSemana, hhmm } = agora;
  for (const [ini, fim] of (h[diaSemana] || [])) {
    if (hhmm >= ini && hhmm < fim) {
      return { aberto: true, fecha: fim, rotulo: `Aberto · fecha às ${fim}` };
    }
  }
  // Ainda vai abrir hoje?
  const maisTarde = (h[diaSemana] || []).find(([ini]) => hhmm < ini);
  if (maisTarde) {
    return { aberto: false, abre: maisTarde[0], quando: 'hoje',
             rotulo: `Fechado · abre hoje às ${maisTarde[0]}` };
  }
  // Procura o próximo dia com expediente, olhando a semana inteira.
  for (let salto = 1; salto <= 7; salto++) {
    const d = (diaSemana + salto) % 7;
    if (!h[d] || !h[d].length) continue;
    const quando = salto === 1 ? 'amanhã' : DIAS[d];
    return { aberto: false, abre: h[d][0][0], quando,
             rotulo: `Fechado · abre ${quando} às ${h[d][0][0]}` };
  }
  return { aberto: false, rotulo: 'Fechado' };
}

/**
 * Marca que NÃO deve aparecer na vitrine.
 *
 * `(todas)` está em 49 dos 64 produtos do `produtosbomgosto` — é lixo de
 * importação, e impresso em cada card faz a loja parecer mal cadastrada. O
 * filtro é SÓ de exibição pública: o cadastro continua intacto, e corrigir os
 * dados em massa é decisão do lojista, não efeito colateral de uma tela.
 */
const MARCAS_LIXO = new Set(['(todas)', '(todos)', 'todas', 'todos', 'n/a', 'na', '-', '--', 'sem marca']);
function marcaVisivel(marca) {
  const m = String(marca == null ? '' : marca).trim();
  if (!m) return null;
  return MARCAS_LIXO.has(m.toLowerCase()) ? null : m;
}

/**
 * Preço "de", riscado, quando o produto está mais barato do que o de tabela.
 *
 * Não existe campo de promoção neste ERP, e inventar um seria criar uma segunda
 * verdade sobre preço. O que existe é `tabelas_preco` com vigência, que o
 * `resolverPreco` (cliente logado) e o `precoPromocional` (visitante) aplicam —
 * então promoção aqui é exatamente isto: o preço resolvido veio ABAIXO do
 * `precoVenda` cadastrado.
 *
 * Devolve null quando não há diferença, e a tela não desenha nada.
 */
function precoAnterior(cfg, produto, precoResolvido) {
  if (!cfg.mostrarPreco || precoResolvido == null) return null;
  const cheio = r2c(produto.precoVenda);
  if (!(cheio > 0) || !(precoResolvido < cheio)) return null;
  return cheio;
}

/**
 * Grupos de personalização de um produto, para o catálogo público.
 *
 * Lê as tabelas do módulo Restaurante (ver a nota no db-schema.js): elas já
 * expressam escolha única/múltipla, obrigatoriedade, faixa de quantidade e
 * adicional em reais, e não têm vínculo nenhum com `rest_comandas`.
 *
 * Tolerante à ausência das tabelas: tenant sem o schema do restaurante
 * simplesmente não tem personalização, em vez de derrubar o catálogo.
 */
function personalizacoesDe(db, produtoId) {
  try {
    const grupos = db.prepare(`SELECT g.id, g.nome, g.descricao, g.minEscolhas, g.maxEscolhas,
        COALESCE(g.tipo, 'escolha') AS tipo, pg.ordem
      FROM rest_produto_grupos pg
      JOIN rest_grupos_opcao g ON g.id = pg.grupoId
      WHERE pg.produtoId = ? AND g.ativo = 1
      ORDER BY pg.ordem, g.ordem, g.id`).all(produtoId);

    const opcoes = db.prepare(`SELECT id, grupoId, nome, precoAdicional
      FROM rest_opcoes WHERE ativo = 1 ORDER BY ordem, id`).all();

    return grupos.map((g) => ({
      id: g.id, nome: g.nome, descricao: g.descricao || null, tipo: g.tipo,
      minEscolhas: Number(g.minEscolhas) || 0,
      maxEscolhas: Number(g.maxEscolhas) || 1,
      obrigatorio: (Number(g.minEscolhas) || 0) > 0,
      opcoes: g.tipo === 'texto' ? [] : opcoes
        .filter((o) => o.grupoId === g.id)
        .map((o) => ({ id: o.id, nome: o.nome, precoAdicional: r2c(o.precoAdicional) })),
    }));
  } catch { return []; }
}

/**
 * Confere as escolhas do comprador contra os grupos REAIS do produto.
 *
 * A validação é por pertencimento, não por existência: não basta a opção
 * existir, ela precisa pertencer a um grupo DAQUELE produto. Sem isso, mandar o
 * id de uma opção de outro item passaria — e é o primeiro lugar onde alguém
 * tentaria mexer.
 */
function validarEscolhas(grupos, idsEscolhidos, textos) {
  const escolhidas = [...new Set(idsEscolhidos.filter((n) => Number.isFinite(n) && n > 0))];
  const validas = [];
  const textosOk = {};
  const permitidas = new Set();
  for (const g of grupos) for (const o of g.opcoes) permitidas.add(o.id);

  for (const id of escolhidas) {
    if (!permitidas.has(id)) {
      return { erro: 'Opção inválida para este produto' };
    }
  }

  for (const g of grupos) {
    if (g.tipo === 'texto') {
      const t = String(textos[g.id] ?? textos[String(g.id)] ?? '').trim().slice(0, 300);
      if (g.obrigatorio && !t) return { erro: `"${g.nome}" é obrigatório` };
      if (t) textosOk[g.id] = t;
      continue;
    }
    const doGrupo = g.opcoes.filter((o) => escolhidas.includes(o.id));
    if (doGrupo.length < g.minEscolhas) {
      return { erro: `"${g.nome}" exige ao menos ${g.minEscolhas} opção(ões)` };
    }
    if (doGrupo.length > g.maxEscolhas) {
      return { erro: `"${g.nome}" aceita no máximo ${g.maxEscolhas} opção(ões)` };
    }
    for (const o of doGrupo) {
      // `grupoNome` junto: na sacola, "Modelo 4" sozinho não diz de que é.
      validas.push({ id: o.id, grupoId: g.id, grupoNome: g.nome, nome: o.nome,
                     precoAdicional: r2c(o.precoAdicional) });
    }
  }
  return { opcoes: validas, textos: textosOk };
}

/**
 * Ordem das categorias na vitrine, como Map nome→posição.
 *
 * Um só lugar porque a central e a vitrine pública precisam ordenar igual: se
 * cada uma lesse por conta própria, o lojista arrastaria na central e veria
 * outra ordem no ar — e levaria tempo até desconfiar de qual das duas mente.
 *
 * Ausente do Map = nunca ordenada. Quem chama trata isso como "vai depois das
 * ordenadas", nunca como posição 0.
 */
function ordemCategorias(db) {
  const m = new Map();
  try {
    for (const r of db.prepare('SELECT categoria, ordem FROM loja_categoria_ordem').all()) {
      m.set(String(r.categoria).trim(), Number(r.ordem) || 0);
    }
  } catch (_) { /* base ainda sem a tabela de ordem */ }
  return m;
}

/** Comparador de categorias da vitrine: ordenadas primeiro, resto alfabético. */
function compararCategorias(ordem) {
  return (a, b) => {
    const oa = ordem.get(a) || 0, ob = ordem.get(b) || 0;
    if (oa !== ob) {
      if (!oa) return 1;
      if (!ob) return -1;
      return oa - ob;
    }
    return a.localeCompare(b, 'pt-BR');
  };
}

/**
 * Saldo que o comprador pode contar: entradas menos saídas, menos o que já
 * está reservado para outro pedido. Mostrar o saldo cru é como vender assento
 * já ocupado — a mesma conta do resto do ERP.
 */
function disponivelDe(db, produtoId) {
  try {
    /* Kit não tem saldo próprio (as saídas são dos componentes). Quantos kits
       dá para montar é o menor "disponível ÷ quantidade na composição" entre
       os componentes. Somar o saldo do próprio kit dava sempre zero, e todo
       buquê pronto aparecia "sob consulta". */
    const p = db.prepare('SELECT tipoProduto FROM produtos WHERE id = ?').get(produtoId);
    if (p && p.tipoProduto === 'kit') {
      const comps = db.prepare('SELECT produtoFilhoId, quantidade FROM produto_kit_itens WHERE produtoPaiId = ?').all(produtoId);
      if (!comps.length) return 0;
      return Math.min(...comps.map(c => (Number(c.quantidade) > 0
        ? Math.floor(disponivelDe(db, c.produtoFilhoId) / Number(c.quantidade)) : Infinity)));
    }
    const s = db.prepare(`SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
        WHEN tipo='saida' THEN -quantidade ELSE quantidade END), 0) s
      FROM movimentacoes_estoque WHERE produtoId = ?`).get(produtoId).s;
    const r = db.prepare(`SELECT COALESCE(SUM(quantidade),0) q FROM reservas_estoque
      WHERE produtoId = ? AND status = 'ativa'`).get(produtoId).q;
    return Math.max(0, Number(s) - Number(r));
  } catch { return 0; }
}

// Quantidade exata é inteligência de negócio: o concorrente também abre a
// vitrine. O comprador precisa saber se dá para comprar, não quanto existe.
function rotuloEstoque(qtd) {
  if (qtd <= 0) return 'sob-consulta';
  if (qtd <= 3) return 'ultimas';
  return 'disponivel';
}

// O comprador escolhe entre o que a loja aceita; fora disso, manda a loja.
function escolherForma(modo, pedida) {
  if (modo === 'pix' || modo === 'boleto') return modo;
  return pedida === 'boleto' ? 'boleto' : 'pix';
}

const somaDias = (n) => {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000 + (Number(n) || 0) * 86400000);
  return d.toISOString().slice(0, 10);
};

/**
 * Gera a conta a receber do pedido e emite Pix ou boleto por ela.
 *
 * Reusa a régua do financeiro inteira: a CR fica amarrada ao pedido, a emissão
 * passa pelo provedor configurado (Asaas, Sicredi, Mercado Pago) e a baixa vem
 * pelo webhook que já existe. Nada de um caminho de pagamento paralelo.
 */
async function emitirCobranca(db, { pedidoId, pessoaId, valor, numero, forma, vencimentoDias }) {
  const orq = require('./boleto-orchestrator');
  const hoje = somaDias(0);
  const crId = db.prepare(`INSERT INTO contas_a_receber
      (pessoaId, descricao, valor, valorPago, dataEmissao, dataVencimento, status, origem,
       origemTipo, pedidoId, dataAtualizacao)
    VALUES (?, ?, ?, 0, ?, ?, 'aberta', 'loja', 'pedido', ?, CURRENT_TIMESTAMP)`)
    .run(pessoaId, `Pedido ${numero} — loja virtual`, valor, hoje,
         somaDias(vencimentoDias ?? 3), pedidoId).lastInsertRowid;

  const r = forma === 'boleto'
    ? await orq.emitirBoletoParaCR(db, crId)
    : await orq.emitirCobrancaPixParaCR(db, crId);

  // skipped = falta conta financeira ou provedor sem suporte. A CR fica de pé
  // para o financeiro cobrar do jeito de sempre.
  if (r?.skipped) return { contaReceberId: crId, forma, pendente: true, motivo: r.motivo };
  return {
    contaReceberId: crId, forma,
    pixPayload: r?.pixPayload || null, pixQrImage: r?.pixQrImage || null,
    linhaDigitavel: r?.linhaDigitavel || r?.codigoBarras || null,
    url: r?.invoiceUrl || r?.urlBoleto || r?.linkPagamento || null,
    vencimento: somaDias(vencimentoDias ?? 3),
  };
}

// ==================== PÚBLICO (sem login) ====================

function registrarRotasLojaPublica(app, db) {
  // Sem migrarLojaDB aqui: no boot o `db` é o proxy com stubs, e criar tabela
  // nesse contexto é no-op silencioso. O schema vem de applyRouteMigrations
  // (tenant novo) e de scripts/migrate-loja.js (tenants existentes).

  // A sessão do portal pode ou não existir numa rota pública — daí a leitura
  // direta em vez do middleware, que responderia 401 ao visitante.
  const pessoaLogada = (req) => {
    if (!req.session?.clienteLoginId) return null;
    try {
      const c = db.prepare('SELECT pessoaId FROM cliente_logins WHERE id = ? AND ativo = 1')
        .get(req.session.clienteLoginId);
      return c ? c.pessoaId : null;
    } catch { return null; }
  };

  /**
   * Erro INESPERADO numa rota anônima: o detalhe fica do lado de cá e o
   * visitante recebe uma frase só.
   *
   * O motivo é quem está do outro lado. Estas rotas respondem a quem não fez
   * login nenhum, e `e.message` do SQLite carrega nome de tabela, nome de
   * coluna e trecho de SQL — um mapa do banco entregue a pedido.
   *
   * Isto NÃO alcança as recusas de negócio. "Loja não publicada", "Produto não
   * encontrado", quantidade inválida e personalização inválida são
   * `return res.status(4xx)` dentro do `try`: retornam sem lançar e nunca
   * passam por aqui. Quem chega neste ponto é exceção, e exceção não tem
   * mensagem para o cliente.
   */
  const erroInterno = (res, rota, e) => {
    console.error(`[loja] ${rota}:`, e.message);
    return res.status(500).json({ success: false,
      error: 'Não foi possível carregar agora. Tente de novo em instantes.' });
  };

  /* Visitante sem login vê a PROMOÇÃO vigente (precos-routes.precoPromocional),
     e só ela: tabela comercial sem vigência continua sendo do cliente
     vinculado. O preço cheio vira o riscado pelo `precoAnterior`, e o mesmo
     preço vale no carrinho e no pedido, que passam por esta mesma função. */
  const precoVisivel = (cfg, produto, pessoaId) => {
    if (pessoaId) return resolverPreco(db, produto.id, { pessoaId, quantidade: 1 }).preco;
    if (!cfg.mostrarPreco) return null;
    const promo = precoPromocional(db, produto.id, 1);
    return promo ? promo.preco : (Number(produto.precoVenda) || 0);
  };

  const fotosDe = (produtoId, imagemPath) => {
    try {
      const g = db.prepare('SELECT caminho FROM produto_imagens WHERE produtoId = ? ORDER BY ordem').all(produtoId);
      if (g.length) return g.map(x => x.caminho);
    } catch { /* instalação sem a tabela de imagens */ }
    return imagemPath ? [imagemPath] : [];
  };

  app.get('/loja/api/config', (req, res) => {
    try {
      const c = lerConfig(db);
      if (!c.ativa) return res.status(404).json({ success: false, error: 'Loja não publicada' });
      /* Identidade pública, com FALLBACK para o cadastro da empresa.
         A regra é a mesma em toda linha: o que o lojista configurou no Catálogo
         Online vence; faltando, usa-se o dado geral do emitente. Nada é
         duplicado — `loja_config` só guarda o que DIVERGE do cadastro. */
      const emp = empresaDe(db);

      // Só o que a página precisa: nada de e-mail interno ou flags de gestão.
      res.json({ success: true, loja: {
        nome: c.nome || emp.nome || 'Catálogo',
        descricao: c.descricao || null,
        logo: c.logoPath || emp.logo || null,
        banner: c.bannerPath || null,
        // Saneado na saída: o que vai para o `href` de um link público não pode
        // carregar `javascript:` nem apontar para outro domínio.
        instagram: usuarioRede(c.instagram, 'instagram.com'),
        facebook: usuarioRede(c.facebook, 'facebook.com'),
        // Normalizado no BACKEND, como pedido: o navegador recebe pronto.
        whatsapp: whatsappNormalizado(c.whatsapp || emp.telefone),
        email: c.email || null,
        telefone: c.telefone || emp.telefone || null,
        // Endereço só vai ao ar se o lojista marcou que pode.
        endereco: c.mostrarEndereco ? (c.endereco || emp.endereco || null) : null,
        // Informativo nesta fase: não bloqueia carrinho nem pedido.
        atendimento: statusAtendimento(c.horarios),
        horarios: lerHorarios(c.horarios),
        // Serviços, frete e cobertura — o que o painel Informações precisa.
        entrega: entregaPublica(db, c),
        // Enquadramento escolhido pelo lojista; a imagem em si é a original.
        logoFoco: lerFoco(c.logoFoco),
        bannerFoco: lerFoco(c.bannerFoco),
        mostrarPreco: !!c.mostrarPreco, mostrarEstoque: !!c.mostrarEstoque, tema: c.tema,
        pagamento: c.pagamentoModo || 'nenhum',
        // Pix no fechamento do pedido: a loja cobra assim E há provedor que gere.
        // Nesse caso o checkout oferece só o Pix e pede CPF, que o Asaas exige.
        pixNoSite: pagamentoLoja.pixNoCheckout(c) && pagamentoLoja.provedorPixPronto(db),
        favicon: c.faviconPath || null,
        rodape: c.rodapeTexto || null,
      } });
    } catch (e) { return erroInterno(res, '/loja/api/config', e); }
  });

  /* Ícones e manifest da loja (29/09), só com a loja publicada e com ícone
   * enviado. Ao lado do `faviconPath` podem existir versões por tamanho, com o
   * sufixo `-16`, `-32`, `-180` e `-192`: a de 16 px, redesenhada, é a que se
   * lê na aba. Faltando a versão, vai o ícone enviado, e o navegador o reduz.
   * O ERP não referencia nada disto: o manifest e os ícones dele são outros. */
  const TAMANHOS_ICONE = new Set(['16', '32', '180', '192', '512']);
  app.get('/loja/icones/:arq', (req, res) => {
    try {
      const m = /^(\d+)\.png$/.exec(req.params.arq || '');
      if (!m || !TAMANHOS_ICONE.has(m[1])) return res.status(404).end();
      const c = lerConfig(db);
      if (!c.ativa || !c.faviconPath) return res.status(404).end();
      const fs = require('fs');
      const pasta = path.join(RAIZ_PUBLICA, SUBDIR_LOJA) + path.sep;
      const original = path.join(RAIZ_PUBLICA, c.faviconPath);
      const variante = original.replace(/\.[a-z0-9]+$/i, `-${m[1]}.png`);
      const arq = fs.existsSync(variante) ? variante : original;
      if (!arq.startsWith(pasta) || !fs.existsSync(arq)) return res.status(404).end();
      res.set('Cache-Control', 'public, max-age=300').sendFile(arq);
    } catch (e) { return erroInterno(res, '/loja/icones', e); }
  });

  app.get('/loja/manifest.webmanifest', (req, res) => {
    try {
      const c = lerConfig(db);
      if (!c.ativa || !c.faviconPath) return res.status(404).end();
      const t = c.tema || {};
      const nome = c.nome || empresaDe(db).nome || 'Loja';
      res.type('application/manifest+json').set('Cache-Control', 'public, max-age=300').send(JSON.stringify({
        name: nome, short_name: nome.slice(0, 30), start_url: '/loja/', scope: '/loja/',
        theme_color: t.corTema || t.corPrimaria,
        ...(t.corFundo ? { background_color: t.corFundo } : {}),
        icons: [{ src: '/loja/icones/192.png', sizes: '192x192', type: 'image/png' },
                { src: '/loja/icones/512.png', sizes: '512x512', type: 'image/png' }],
      }));
    } catch (e) { return erroInterno(res, '/loja/manifest.webmanifest', e); }
  });

  app.get('/loja/api/produtos', (req, res) => {
    try {
      const c = lerConfig(db);
      if (!c.ativa) return res.status(404).json({ success: false, error: 'Loja não publicada' });

      const q = String(req.query.q || '').trim().toLowerCase();
      const categoria = String(req.query.categoria || '').trim();
      /* Lista de colunas explícita: SELECT * aqui publicaria precoCusto e markup
         para a internet inteira. `destaqueNaLoja` entra porque é atributo de
         VITRINE — a mesma estrela que o lojista marca no Catálogo Online. */
      let sql = `SELECT id, sku, descricao, marca, modelo, categoria, unidade, precoVenda, imagemPath,
          COALESCE(destaqueNaLoja, 0) AS destaque
        FROM produtos WHERE ativo = 1 AND publicadoNaLoja = 1`;
      const args = [];
      if (categoria) { sql += ' AND categoria = ?'; args.push(categoria); }
      // A ordem escolhida na central vale AQUI — é esta a vitrine. Mesma regra
      // do lado administrativo: posicionado à mão primeiro, resto alfabético.
      sql += ` ORDER BY CASE WHEN COALESCE(ordemVitrine, 0) > 0 THEN 0 ELSE 1 END,
                        COALESCE(ordemVitrine, 0), descricao`;
      let linhas = db.prepare(sql).all(...args);
      if (q) {
        linhas = linhas.filter(p => ['descricao', 'sku', 'marca', 'modelo']
          .some(k => String(p[k] || '').toLowerCase().includes(q)));
      }

      // Cliente logado sempre vê preço, e o preço DELE: é a razão de existir
      // login numa vitrine B2B. Visitante anônimo depende da chave do lojista.
      const pessoaId = pessoaLogada(req);
      const produtos = linhas.map(p => {
        /* Montável: o preço é o da tabela, e o card mostra o menor dela. Não
           tem saldo próprio (as flores têm), então não leva rótulo de estoque. */
        if (montagem.ehMontavel(db, p.id)) {
          return {
            id: p.id, sku: p.sku, descricao: p.descricao, modelo: p.modelo,
            categoria: p.categoria, unidade: p.unidade, destaque: !!p.destaque,
            marca: marcaVisivel(p.marca), montavel: true,
            preco: c.mostrarPreco ? montagem.precoInicial(db, p.id) : null,
            precoAnterior: null, temPersonalizacao: true, estoque: null,
            fotos: fotosDe(p.id, p.imagemPath),
          };
        }
        const disp = disponivelDe(db, p.id);
        const preco = precoVisivel(c, p, pessoaId);
        return {
          id: p.id, sku: p.sku, descricao: p.descricao, modelo: p.modelo,
          categoria: p.categoria, unidade: p.unidade,
          destaque: !!p.destaque,
          // `marca` passa pelo filtro de lixo de importação — "(todas)" não vai
          // ao ar. O cadastro continua como está.
          marca: marcaVisivel(p.marca),
          preco,
          precoAnterior: precoAnterior(c, p, preco),
          // Com personalização obrigatória o "+" não pode adicionar direto: a
          // tela precisa abrir o produto antes.
          temPersonalizacao: personalizacoesDe(db, p.id).length > 0,
          estoque: c.mostrarEstoque ? rotuloEstoque(disp) : null,
          fotos: fotosDe(p.id, p.imagemPath),
        };
      });
      const categorias = [...new Set(linhas.map(p => (p.categoria || '').trim()).filter(Boolean))]
        .sort(compararCategorias(ordemCategorias(db)));
      res.json({ success: true, total: produtos.length, categorias, produtos });
    } catch (e) { return erroInterno(res, '/loja/api/produtos', e); }
  });

  /* O montador: flores, formatos com a tabela, cores com o que o estoque fecha
     e os adicionais de cada montável publicado. */
  app.get('/loja/api/montagem', (req, res) => {
    try {
      const c = lerConfig(db);
      if (!c.ativa) return res.status(404).json({ success: false, error: 'Loja não publicada' });
      let ids = [];
      try {
        ids = db.prepare(`SELECT m.produtoId FROM loja_montaveis m JOIN produtos p ON p.id = m.produtoId
          WHERE m.ativo = 1 AND p.ativo = 1 AND p.publicadoNaLoja = 1
          ORDER BY m.ordem, COALESCE(p.ordemVitrine, 0), p.descricao`).all().map((r) => r.produtoId);
      } catch { /* tenant sem a tabela */ }
      const montaveis = ids.map((id) => {
        const p = db.prepare('SELECT id, descricao, observacoes, imagemPath FROM produtos WHERE id = ?').get(id);
        const m = montagem.montavelPublico(db, id, { mostrarPreco: !!c.mostrarPreco, disponivelDe: (pid) => disponivelDe(db, pid) });
        if (!m || !m.formatos.length) return null;
        // Sem `observacoes`: é recado interno do lojista, nenhuma tela da loja
        // o usa, e no JSON público ele ia para a internet inteira.
        return { ...m, descricao: p.descricao,
                 foto: fotosDe(p.id, p.imagemPath)[0] || null, adicionais: personalizacoesDe(db, id) };
      }).filter(Boolean);
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, montaveis });
    } catch (e) { return erroInterno(res, '/loja/api/montagem', e); }
  });

  pagamentoLoja.registrarRotasPagamentoPublico(app, db);

  // ---------- área do comprador (login do portal) ----------
  // O comprador da vitrine é o mesmo cliente do portal: mesma tabela de
  // login, mesma sessão. Um segundo cadastro de senha seria mais uma senha
  // para o cliente esquecer e mais um lugar para revogar acesso.
  const compradorAuth = requirePortalAuth(db);

  const itensDoCarrinho = (pessoaId) => {
    const linhas = db.prepare(`SELECT c.produtoId, c.quantidade, p.sku, p.descricao, p.unidade, p.imagemPath
      FROM loja_carrinho c JOIN produtos p ON p.id = c.produtoId
      WHERE c.pessoaId = ? AND p.ativo = 1 AND p.publicadoNaLoja = 1
      ORDER BY p.descricao`).all(pessoaId);
    return linhas.map(l => {
      // Preço resolvido item a item: a faixa de quantidade muda o valor, e
      // congelar o preço na entrada do carrinho esconderia isso do comprador.
      const r = resolverPreco(db, l.produtoId, { pessoaId, quantidade: l.quantidade });
      const disp = disponivelDe(db, l.produtoId);
      return {
        produtoId: l.produtoId, sku: l.sku, descricao: l.descricao, unidade: l.unidade,
        foto: l.imagemPath || null, quantidade: l.quantidade,
        preco: r.preco, total: Number((r.preco * l.quantidade).toFixed(2)),
        fontePreco: r.fonte, tabelaNome: r.tabelaNome || null,
        disponivel: disp, suficiente: disp >= l.quantidade,
      };
    });
  };

  app.get('/loja/api/eu', compradorAuth, (req, res) => {
    res.json({ success: true, cliente: { nome: req.cliente.razaoSocial, email: req.cliente.email } });
  });

  app.get('/loja/api/carrinho', compradorAuth, (req, res) => {
    try {
      const itens = itensDoCarrinho(req.cliente.pessoaId);
      res.json({ success: true, itens, total: Number(itens.reduce((s, i) => s + i.total, 0).toFixed(2)) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/loja/api/carrinho', compradorAuth, (req, res) => {
    try {
      const produtoId = Number(req.body?.produtoId);
      const qtd = Number(req.body?.quantidade);
      const p = db.prepare('SELECT id FROM produtos WHERE id = ? AND ativo = 1 AND publicadoNaLoja = 1').get(produtoId);
      if (!p) return res.status(404).json({ success: false, error: 'Produto não está na vitrine' });
      if (!(qtd > 0)) {
        db.prepare('DELETE FROM loja_carrinho WHERE pessoaId = ? AND produtoId = ?').run(req.cliente.pessoaId, produtoId);
      } else {
        db.prepare(`INSERT INTO loja_carrinho (pessoaId, produtoId, quantidade) VALUES (?,?,?)
          ON CONFLICT(pessoaId, produtoId) DO UPDATE SET quantidade = excluded.quantidade,
            dataAtualizacao = CURRENT_TIMESTAMP`).run(req.cliente.pessoaId, produtoId, qtd);
      }
      const itens = itensDoCarrinho(req.cliente.pessoaId);
      res.json({ success: true, itens, total: Number(itens.reduce((s, i) => s + i.total, 0).toFixed(2)) });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * Fecha o carrinho como pedido do ERP. Nasce em rascunho, com reserva de
   * estoque — o lojista confirma na tela de pedidos que já usa. Não é um
   * registro paralelo: mesma tabela, mesma numeração, mesmo fluxo.
   */
  app.post('/loja/api/pedido', compradorAuth, async (req, res) => {
    try {
      const pessoaId = req.cliente.pessoaId;
      const itens = itensDoCarrinho(pessoaId);
      if (!itens.length) return res.status(400).json({ success: false, error: 'Seu carrinho está vazio' });

      // Conferência no fechamento, não na exibição: entre montar o carrinho e
      // enviar, o balcão pode ter vendido a mesma peça.
      const faltando = itens.filter(i => !i.suficiente);
      if (faltando.length) {
        return res.status(409).json({ success: false, semEstoque: faltando.map(i => ({
          descricao: i.descricao, pedido: i.quantidade, disponivel: i.disponivel })),
          error: 'Alguns itens não têm mais a quantidade pedida' });
      }

      const observacao = ['[Loja virtual]', String(req.body?.observacao || '').trim()].filter(Boolean).join(' ');
      const pedidoId = db.transaction(() => {
        const numero = gerarNumero(db, 'pedido');
        // tipo='catalogo' desde 2026-09-10: a origem do pedido passa a ser
        // legível em `pedidos.tipo`, que nenhum filtro ou relatório consome
        // (auditado no relatório 12). `origemLoja` continua como está — é o que
        // as consultas desta loja usam, e mexer nele quebraria as telas dela.
        const id = db.prepare(`INSERT INTO pedidos
            (numero, tipo, modoDocumento, clienteId, status, dataPedido, observacao, depositoId, origemLoja)
          VALUES (?, 'manual', 'pedido', ?, 'rascunho', date('now','-3 hours'), ?, ?, 1)`)
          .run(numero, pessoaId, observacao.slice(0, 500), resolverDeposito(db, {})).lastInsertRowid;
        const ins = db.prepare(`INSERT INTO pedido_itens
            (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal) VALUES (?,?,?,?,?,?)`);
        for (const i of itens) ins.run(id, i.produtoId, i.descricao, i.quantidade, i.preco, i.total);
        recalcularTotal(db, id);
        db.prepare('DELETE FROM loja_carrinho WHERE pessoaId = ?').run(pessoaId);
        return id;
      })();

      // A reserva é o que impede vender a mesma peça duas vezes. Se falhar, o
      // pedido continua válido — e o lojista vê a falta na conferência.
      let reserva = null;
      try { reserva = criarReservasPedido(db, pedidoId); }
      catch (e) { reserva = { erro: e.message }; }

      const p = db.prepare('SELECT numero, valorTotal FROM pedidos WHERE id = ?').get(pedidoId);

      // Cobrança, quando o lojista pediu. Falhar aqui não invalida o pedido:
      // ele já existe e o financeiro cobra depois — o comprador precisa saber
      // disso em vez de ver um erro e achar que não comprou.
      const c = lerConfig(db);
      let cobranca = null;
      if (c.pagamentoModo && c.pagamentoModo !== 'nenhum' && p.valorTotal > 0) {
        const forma = escolherForma(c.pagamentoModo, req.body?.formaPagamento);
        try { cobranca = await emitirCobranca(db, { pedidoId, pessoaId, valor: p.valorTotal,
          numero: p.numero, forma, vencimentoDias: c.pagamentoVencimentoDias }); }
        catch (e) { cobranca = { erro: e.message }; }
      }

      res.json({ success: true, pedidoId, numero: p.numero, valorTotal: p.valorTotal,
                 reservado: !reserva?.erro, insuficiencias: reserva?.insuficiencias || [],
                 cobranca });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.get('/loja/api/meus-pedidos', compradorAuth, (req, res) => {
    try {
      // Traz o estado da cobrança junto: "meu pedido" e "meu boleto" são a
      // mesma pergunta para quem comprou.
      const linhas = db.prepare(`SELECT p.id, p.numero, p.status, p.dataPedido, p.valorTotal,
          (SELECT cr.status FROM contas_a_receber cr WHERE cr.pedidoId = p.id ORDER BY cr.id DESC LIMIT 1) AS pagamento
        FROM pedidos p WHERE p.clienteId = ? AND COALESCE(p.origemLoja,0) = 1
        ORDER BY p.id DESC LIMIT 20`).all(req.cliente.pessoaId);
      res.json({ success: true, pedidos: linhas });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Reabrir a cobrança: o comprador fecha a aba antes de pagar o Pix, e o QR
  // tem que estar em algum lugar que ele alcance sozinho.
  app.get('/loja/api/pedido/:id/cobranca', compradorAuth, (req, res) => {
    try {
      const p = db.prepare(`SELECT id, numero FROM pedidos
        WHERE id = ? AND clienteId = ? AND COALESCE(origemLoja,0) = 1`)
        .get(req.params.id, req.cliente.pessoaId);
      if (!p) return res.status(404).json({ success: false, error: 'Pedido não encontrado' });
      const cr = db.prepare(`SELECT id, status, valor, dataVencimento FROM contas_a_receber
        WHERE pedidoId = ? ORDER BY id DESC LIMIT 1`).get(p.id);
      if (!cr) return res.json({ success: true, cobranca: null });
      let b = null;
      try {
        b = db.prepare(`SELECT tipoCobranca, pixPayload, pixQrImage, linhaDigitavel, externalUrl, status
          FROM boletos WHERE contaReceberId = ? ORDER BY id DESC LIMIT 1`).get(cr.id);
      } catch { /* instalação sem o módulo de boletos */ }
      res.json({ success: true, cobranca: {
        numero: p.numero, valor: cr.valor, vencimento: cr.dataVencimento,
        pago: cr.status === 'paga',
        forma: b?.tipoCobranca || null, pixPayload: b?.pixPayload || null,
        pixQrImage: b?.pixQrImage || null, linhaDigitavel: b?.linhaDigitavel || null,
        url: b?.externalUrl || null,
      } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/loja/api/produtos/:id', (req, res) => {
    try {
      const c = lerConfig(db);
      if (!c.ativa) return res.status(404).json({ success: false, error: 'Loja não publicada' });
      const p = db.prepare(`SELECT id, sku, descricao, marca, modelo, categoria, unidade,
          precoVenda, imagemPath, observacoes, pesoBruto, altura, largura, profundidade
        FROM produtos WHERE id = ? AND ativo = 1 AND publicadoNaLoja = 1`).get(req.params.id);
      if (!p) return res.status(404).json({ success: false, error: 'Produto não encontrado' });
      /* Montável não tem página comum: quem chega aqui por link antigo é levado
         ao montador. O JSON ainda responde, e responde como a vitrine — preço
         mínimo da tabela, nunca o `precoVenda` zerado do cadastro — porque o
         `montavel` só é lido DEPOIS de a resposta chegar. */
      const montavel = montagem.ehMontavel(db, p.id);
      const disp = disponivelDe(db, p.id);
      const preco = montavel
        ? (c.mostrarPreco ? montagem.precoInicial(db, p.id) : null)
        : precoVisivel(c, p, pessoaLogada(req));
      res.json({ success: true, produto: {
        ...p, precoVenda: undefined,
        marca: marcaVisivel(p.marca),
        montavel,
        // A observação do montável é recado interno do lojista ("EXEMPLO criado
        // em…"), e nenhuma tela da loja a usa. Fora da resposta, fora do ar.
        observacoes: montavel ? null : p.observacoes,
        preco,
        precoAnterior: montavel ? null : precoAnterior(c, p, preco),
        estoque: montavel ? null : (c.mostrarEstoque ? rotuloEstoque(disp) : null),
        disponivel: montavel ? null : (c.mostrarEstoque ? disp : null),
        fotos: fotosDe(p.id, p.imagemPath),
        personalizacoes: personalizacoesDe(db, p.id),
      } });
    } catch (e) { return erroInterno(res, '/loja/api/produtos/:id', e); }
  });

  /**
   * POST /loja/api/carrinho/calcular — o SERVIDOR é a autoridade do preço.
   *
   * O carrinho do visitante anônimo mora no navegador, e é por isso que esta
   * rota existe: o que o localStorage guarda são REFERÊNCIAS (produto,
   * quantidade, ids de opção, comentário), nunca dinheiro. Todo valor mostrado
   * na sacola volta daqui, recalculado a partir do banco.
   *
   * O que ela recusa, e por quê:
   *   - produto que não está publicado ou não é deste tenant → o item some;
   *   - opção que NÃO pertence a um grupo daquele produto → 422. É o vetor mais
   *     óbvio de fraude: mandar o id de uma opção barata de outro produto, ou o
   *     de um grupo que ninguém ofereceu;
   *   - grupo obrigatório sem escolha, ou fora do mínimo/máximo → 422.
   *
   * `precoAdicional` NUNCA vem do corpo — é lido de `rest_opcoes` pelo id. Um
   * adicional adulterado no navegador não muda um centavo.
   */
  /**
   * Monta os itens do carrinho COM AUTORIDADE DO SERVIDOR.
   *
   * Extraída do handler de `carrinho/calcular` para ser usada também na
   * finalização — a alternativa seria repetir a mesma validação em dois
   * lugares, e a segunda cópia divergiria na primeira correção. Nada do que
   * chega do navegador é aceito como verdade: `produtoId` e `quantidade` são
   * referências, e preço, opções e textos são resolvidos aqui.
   *
   * @returns {{erro?:string, status?:number, item?:number, produtoId?:number, itens?:Array}}
   */
  function montarItensDoCarrinho(c, bruto, pessoaId) {
    if (bruto.length > 200) {
      return { erro: 'Carrinho grande demais', status: 422 };
    }
    const itens = [];
    for (const [i, entrada] of bruto.entries()) {
      const produtoId = Number(entrada && entrada.produtoId);
      const quantidade = Math.floor(Number(entrada && entrada.quantidade) || 0);
      if (!Number.isFinite(produtoId) || produtoId <= 0 || quantidade <= 0) continue;

      const p = db.prepare(`SELECT id, sku, descricao, marca, unidade, precoVenda, imagemPath
        FROM produtos WHERE id = ? AND ativo = 1 AND publicadoNaLoja = 1`).get(produtoId);
      if (!p) continue;                       // despublicado entre visitas: some da sacola

      const grupos = personalizacoesDe(db, p.id);
      const escolhidas = Array.isArray(entrada.opcoes) ? entrada.opcoes.map(Number) : [];
      const textos = (entrada.textos && typeof entrada.textos === 'object') ? entrada.textos : {};

      const validado = validarEscolhas(grupos, escolhidas, textos);
      if (validado.erro) {
        return { erro: validado.erro, status: 422, item: i, produtoId };
      }

      /* Montável: o preço é o da linha da tabela e a quantidade é sempre 1,
         porque cada montagem é um presente. O que vai dentro (flores e papel)
         segue em `componentes`, para o pedido baixar do estoque. */
      let mont = null;
      if (montagem.ehMontavel(db, p.id)) {
        if (quantidade !== 1) return { erro: 'Cada montagem entra uma vez na sacola.', status: 422, item: i, produtoId };
        mont = montagem.resolverMontagem(db, p.id, entrada.montagem,
          { mostrarPreco: !!c.mostrarPreco, disponivelDe: (pid) => disponivelDe(db, pid) });
        if (mont.erro) return { erro: mont.erro, status: 422, item: i, produtoId };
      } else if (entrada.montagem) {
        return { erro: 'Este produto não é montável.', status: 422, item: i, produtoId };
      }

      const precoBase = mont ? mont.preco : precoVisivel(c, p, pessoaId);
      const adicional = validado.opcoes.reduce((s, o) => s + o.precoAdicional, 0);
      const unitario = precoBase == null ? null : r2c(precoBase + adicional);

      itens.push({
        produtoId: p.id, sku: p.sku, descricao: mont ? `${p.descricao} — ${mont.detalhe}` : p.descricao,
        ...(mont ? { montagem: mont.montagem, componentes: mont.componentes, dataDesejada: mont.dataDesejada } : {}),
        marca: marcaVisivel(p.marca), unidade: p.unidade,
        foto: (fotosDe(p.id, p.imagemPath)[0] || null),
        quantidade,
        precoBase, adicional: r2c(adicional), precoUnitario: unitario,
        total: unitario == null ? null : r2c(unitario * quantidade),
        opcoes: validado.opcoes.map((o) => ({ id: o.id, grupoId: o.grupoId, grupoNome: o.grupoNome,
                                              nome: o.nome, precoAdicional: o.precoAdicional })),
        textos: validado.textos,
        // O texto livre com o NOME do grupo ("Mensagem do cartão"), que é o que
        // a linha do pedido precisa mostrar; `textos` é chaveado pelo id.
        textosNomeados: Object.entries(validado.textos).map(([gid, texto]) => ({
          nome: (grupos.find((g) => g.id === Number(gid)) || {}).nome || 'Texto', texto })),
        comentario: entrada.comentario == null ? null : String(entrada.comentario).trim().slice(0, 300) || null,
      });
    }
    return { itens };
  }

  app.post('/loja/api/carrinho/calcular', (req, res) => {
    try {
      const c = lerConfig(db);
      if (!c.ativa) return res.status(404).json({ success: false, error: 'Loja não publicada' });

      const bruto = Array.isArray(req.body?.itens) ? req.body.itens : [];

      const r = montarItensDoCarrinho(c, bruto, pessoaLogada(req));
      if (r.erro) {
        return res.status(r.status).json({ success: false, error: r.erro,
                                           item: r.item, produtoId: r.produtoId });
      }
      const itens = r.itens;

      const semPreco = itens.some((i) => i.total == null);
      const total = r2c(itens.reduce((s, i) => s + (i.total || 0), 0));
      res.json({ success: true, itens, total, semPreco,
                 quantidadeItens: itens.reduce((s, i) => s + i.quantidade, 0) });
    } catch (e) { return erroInterno(res, '/loja/api/carrinho/calcular', e); }
  });

  /**
   * POST /loja/api/pedido/finalizar — o checkout público.
   *
   * Uma tentativa de checkout vira, no máximo, UM pedido comercial normal.
   *
   * ── O que o servidor decide, e o navegador não ─────────────────────────
   * preço, frete, total, origem (`catalogo`) e o texto das personalizações.
   * Do corpo vêm referências (produtoId, quantidade, ids de opção) e o que só
   * o cliente sabe (nome, telefone, endereço, forma de pagamento).
   *
   * ── Atômico ────────────────────────────────────────────────────────────
   * Pessoa, pedido, itens, frete, atendimento, pagamento e CONFIRMAÇÃO — que
   * é quem reserva estoque — acontecem numa transação só. `better-sqlite3`
   * aninha por savepoint, e o rollback externo desfaz o interno: falhando
   * qualquer etapa, não sobra pessoa órfã, rascunho abandonado, item solto
   * nem reserva parcial. Nenhum DELETE compensatório.
   *
   * ── Idempotência ───────────────────────────────────────────────────────
   * `pedidos.idempotenciaChave` com UNIQUE parcial. A consulta prévia serve
   * ao caso comum (retry depois da resposta perdida); quem garante sob
   * concorrência é a constraint — entre um SELECT e um INSERT cabe a segunda
   * requisição, e é exatamente aí que o duplo clique cai.
   */
  /**
   * Reenvio da MESMA tentativa: devolve o pedido que já existe.
   *
   * Antes de devolver, confere que a intenção é a mesma — recalculando a
   * impressão a partir do que está gravado. Se mudou, 409: a chave já foi
   * usada para outro pedido, e responder o antigo como se fosse o novo seria
   * mentir para quem comprou.
   */
  function responderExistente(res, pedido, impressaoAgora) {
    const p = db.prepare(`SELECT p.numero, p.valorTotal, p.valorFrete, p.tipoAtendimento,
        p.meioPagamento, pe.razaoSocial, pe.telefone, pe.cpfCnpj, pe.semDocumento
      FROM pedidos p LEFT JOIN pessoas pe ON pe.id = p.clienteId
      WHERE p.id = ?`).get(pedido.id);
    const itens = db.prepare(`SELECT produtoId, quantidade, descricao
      FROM pedido_itens WHERE pedidoId = ? ORDER BY id`).all(pedido.id);
    const codigo = Object.keys(PAGAMENTOS_CHECKOUT)
      .find((k) => PAGAMENTOS_CHECKOUT[k] === p.meioPagamento) || null;

    const impressaoAntes = impressaoDaIntencao({
      nome: p.razaoSocial, telefone: p.telefone,
      documento: Number(p.semDocumento) === 1 ? null : p.cpfCnpj,
      atendimento: p.tipoAtendimento, pagamento: codigo,
      total: r2c(p.valorTotal),
      itens: itens.map((i) => ({ produtoId: i.produtoId, quantidade: i.quantidade,
                                 descricao: i.descricao })),
    });

    if (impressaoAntes !== impressaoAgora) {
      return res.status(409).json({ success: false,
        error: 'Esta tentativa de compra já foi usada para outro pedido. Recarregue a página para começar de novo.' });
    }

    const c = lerConfig(db);
    const lp = (() => { try { return db.prepare('SELECT token, freteACombinar FROM loja_pagamentos WHERE pedidoId = ?').get(pedido.id); } catch { return null; } })();
    const pixNoSite = pagamentoLoja.pixNoCheckout(c) && pagamentoLoja.provedorPixPronto(db);
    return res.json({
      success: true, repetido: true,
      freteACombinar: !!(lp && lp.freteACombinar), pixNoSite, link: lp ? lp.token : null,
      cobranca: pixNoSite ? pagamentoLoja.estadoDoPedido(db, pedido.id) : null,
      numero: p.numero, total: r2c(p.valorTotal),
      subtotal: r2c(p.valorTotal - (p.valorFrete || 0)), frete: r2c(p.valorFrete || 0),
      atendimento: p.tipoAtendimento,
      pagamento: { codigo, rotulo: ROTULO_PAGAMENTO[codigo] || null },
      whatsapp: whatsappNormalizado(c.whatsapp || (empresaDe(db) || {}).telefone),
    });
  }

  app.post('/loja/api/pedido/finalizar', async (req, res) => {
    /* Erro do cliente é mensagem que ele entende. Nada de SQL, stack, id
       interno ou nome de tenant — a rota é pública. */
    const recusa = (status, error, extra) =>
      res.status(status).json({ success: false, error, ...(extra || {}) });

    try {
      const c = lerConfig(db);
      if (!c.ativa) return recusa(404, 'Este catálogo não está disponível no momento.');

      /* ── a natureza de operação, antes de qualquer criação ──────────────
       *
       * Sem ela o pedido nasceria com `tipoOperacaoId` NULL, e o ERP decidiria
       * três coisas fiscais por omissão: gerar financeiro, ser fiscal e
       * movimentar estoque. Isso funciona por acidente, e num pedido que entra
       * sozinho pela internet o acidente não serve.
       *
       * A recusa vem ANTES de existir pessoa, pedido, item ou reserva, então o
       * lojista que ainda não configurou não fica com meio pedido no banco. A
       * mensagem é de negócio e não diz o que falta: quem lê é o consumidor, e
       * nome de configuração interna não ajuda ninguém do lado de lá.
       *
       * Vale só para o catálogo. O fallback do ERP continua como está para
       * todos os outros módulos e para os pedidos que já existem. */
      const natureza = naturezaDoPedidoDoCatalogo(db, c);
      if (!natureza) {
        return recusa(409, 'Esta loja ainda não está configurada para receber pedidos. '
          + 'Entre em contato com a loja.');
      }

      const b = req.body || {};
      /* Pix no site: a loja cobra por Pix no fechamento E há provedor que o
         gere. Aí o Pix é a única forma, e o CPF passa a ser obrigatório,
         porque o Asaas não emite cobrança sem ele. */
      const pixNoSite = pagamentoLoja.pixNoCheckout(c) && pagamentoLoja.provedorPixPronto(db);

      // ── chave da tentativa ────────────────────────────────────────────
      const chave = txtPub(b.idempotencyKey, 100);
      if (!chave || chave.length < 8) {
        return recusa(422, 'Não foi possível identificar esta tentativa. Recarregue a página e tente de novo.');
      }

      // ── quem está comprando ───────────────────────────────────────────
      const nome = txtPub(b.cliente && b.cliente.nome, 80);
      if (!nome || nome.length < 2) return recusa(422, 'Informe seu nome.');
      const telefone = soDigitos(b.cliente && b.cliente.telefone, 15);
      if (telefone.length < 10) return recusa(422, 'Informe um telefone com DDD.');

      /* Documento é opcional. Informado, precisa ser válido: documento
         inválido no cadastro só aparece na SEFAZ, com a venda feita. */
      let documento = null;
      const docBruto = b.cliente && b.cliente.cpfCnpj;
      if (docBruto != null && String(docBruto).trim() !== '') {
        documento = documentoValido(docBruto);
        if (!documento) return recusa(422, pixNoSite ? 'CPF/CNPJ inválido. Confira os números.' : 'CPF/CNPJ inválido. Confira ou deixe em branco.');
      }
      if (pixNoSite && !documento) return recusa(422, 'Informe seu CPF. O pagamento por Pix precisa dele.');

      // E-mail é opcional; informado, precisa ser um e-mail. O aceite de
      // promoções vai para o cadastro (contato-marketing.js).
      const { lerEmail, aplicarContato } = require('./contato-marketing');
      const email = lerEmail(b.cliente && b.cliente.email);
      if (email === false) return recusa(422, 'E-mail inválido. Confira ou deixe em branco.');
      const aceitePromocoes = !!(b.cliente && b.cliente.aceitePromocoes);

      // ── como recebe ───────────────────────────────────────────────────
      const atendimento = String(b.atendimento || '');
      if (!['retirada', 'entrega'].includes(atendimento)) {
        return recusa(422, 'Escolha se quer retirar ou receber em casa.');
      }
      if (atendimento === 'retirada' && !c.servicoRetirada) {
        return recusa(422, 'No momento esta loja não está aceitando retirada.');
      }
      if (atendimento === 'entrega' && !c.servicoDelivery) {
        return recusa(422, 'No momento esta loja não está fazendo entregas.');
      }

      // ── pagamento: INTENÇÃO, nesta fase ───────────────────────────────
      const pagamento = String(b.pagamento || '');
      if (!PAGAMENTOS_CHECKOUT[pagamento]) {
        return recusa(422, 'Escolha uma forma de pagamento.');
      }
      if (pixNoSite && pagamento !== 'pix') {
        return recusa(422, 'Esta loja recebe pelo Pix.');
      }

      // ── itens, com autoridade do servidor ─────────────────────────────
      const bruto = Array.isArray(b.itens) ? b.itens : [];
      if (!bruto.length) return recusa(422, 'Sua sacola está vazia.');
      const montado = montarItensDoCarrinho(c, bruto, null);
      if (montado.erro) return recusa(montado.status, montado.erro);
      const itens = montado.itens;
      if (!itens.length) {
        return recusa(409, 'Os produtos da sua sacola não estão mais disponíveis.');
      }
      if (itens.some((i) => i.total == null)) {
        return recusa(409, 'Alguns produtos estão sem preço. Fale com a loja para finalizar.');
      }
      const subtotal = r2c(itens.reduce((acc, i) => acc + i.total, 0));

      // ── endereço e frete, quando é entrega ────────────────────────────
      let frete = 0;
      let end = null;
      let freteACombinar = false;
      if (atendimento === 'entrega') {
        const e = b.endereco || {};
        end = {
          logradouro: txtPub(e.logradouro || e.rua, 200),
          numero: txtPub(e.numero, 20),
          complemento: txtPub(e.complemento, 100),
          bairro: txtPub(e.bairro, 80),
          cidade: txtPub(e.cidade, 100),
          uf: (txtPub(e.uf, 2) || '').toUpperCase() || null,
          cep: soDigitos(e.cep, 8) || null,
          referencia: txtPub(e.referencia, 120),
        };
        if (!end.logradouro || !end.numero || !end.bairro || !end.cidade || !end.uf) {
          return recusa(422, 'Complete o endereço de entrega: rua, número, bairro, cidade e estado.');
        }

        const modo = MODOS_FRETE.includes(c.freteModo) ? c.freteModo : 'gratis';
        if (modo === 'gratis') frete = 0;
        else if (modo === 'fixo') frete = r2c(c.freteValor);
        else if (modo === 'combinar') freteACombinar = true;   // a loja lança na tela do pedido
        else {
          const lista = bairrosCobertura(db);
          const alvo = end.bairro.toLowerCase();
          const achado = lista.find((x) => String(x.nome).toLowerCase() === alvo);
          if (achado) frete = r2c(achado.taxa);
          else {
            /* Fora da cobertura. Mesmo com `aceitaForaCobertura`, a
               configuração não diz QUANTO cobrar de quem está fora — não há
               taxa padrão nem "a combinar". Arbitrar 0 daria entrega grátis a
               quem mora longe; arbitrar a maior taxa cobraria um valor que
               ninguém definiu. Recusar é o único caminho que não inventa
               preço, e o cliente fica sabendo o que fazer. */
            return recusa(422, c.aceitaForaCobertura
              ? 'Ainda não temos taxa definida para este bairro. Fale com a loja para combinar a entrega.'
              : 'Ainda não entregamos neste bairro.');
          }
        }
      }

      const total = r2c(subtotal + frete);

      // ── troco: validado, e registrado em texto ────────────────────────
      let linhaTroco = null;
      if (pagamento === 'dinheiro' && b.precisaTroco) {
        const trocoPara = r2c(Number(b.trocoPara));
        if (!(trocoPara > 0)) return recusa(422, 'Informe para quanto precisa de troco.');
        if (trocoPara < total) {
          return recusa(422, `O troco precisa ser a partir de ${total.toFixed(2).replace('.', ',')}.`);
        }
        linhaTroco = `Troco para: R$ ${trocoPara.toFixed(2).replace('.', ',')}`;
      }

      const obsCliente = txtPub(b.observacao, 300);

      /* A observação é o que o atendente lê. O meio de pagamento também vai
         em `pedidos.meioPagamento`, em código SEFAZ; aqui ele aparece por
         extenso porque é onde quem separa e entrega vai olhar. */
      const observacao = ['[Catálogo Online]',
        `Pagamento: ${ROTULO_PAGAMENTO[pagamento]}`,
        freteACombinar ? 'Taxa de entrega a combinar' : null,
        linhaTroco,
        end && end.referencia ? `Referência: ${end.referencia}` : null,
        obsCliente,
      ].filter(Boolean).join(' · ').slice(0, 500);

      /* A impressão da INTENÇÃO, para o caso "mesma chave, outro pedido".
         Reconstruída dos mesmos dados que serão gravados, para poder ser
         recalculada depois a partir do pedido — sem guardar campo novo. */
      const impressao = impressaoDaIntencao({
        nome, telefone, documento, atendimento, pagamento, total,
        itens: itens.map((i) => ({ produtoId: i.produtoId, quantidade: i.quantidade,
                                   descricao: descricaoDoItem(i) })),
      });

      // ── já existe pedido para esta tentativa? ─────────────────────────
      const anterior = db.prepare(
        'SELECT id, numero FROM pedidos WHERE idempotenciaChave = ?').get(chave);
      if (anterior) return responderExistente(res, anterior, impressao);

      // ── a operação, inteira, numa transação ──────────────────────────
      let criado;
      try {
        criado = db.transaction(() => {
          /* Pessoa: reusa por DOCUMENTO, nunca por telefone. Dois clientes
             dividem o mesmo número com frequência (casal, empresa, recado), e
             unir cadastros por isso mistura o histórico de compra de gente
             diferente — sem volta. */
          let pessoaId = null;
          if (documento) {
            const achada = db.prepare('SELECT id FROM pessoas WHERE cpfCnpj = ?').get(documento);
            if (achada) pessoaId = achada.id;
          }
          if (!pessoaId) {
            const chaveDoc = documento || semDoc.gerarIdentificadorSemDocumento();
            pessoaId = db.prepare(`INSERT INTO pessoas
                (cpfCnpj, tipo, razaoSocial, telefone, celular, ativo, semDocumento, origem)
              VALUES (?, ?, ?, ?, ?, 1, ?, 'catalogo')`)
              .run(chaveDoc, documento && documento.length === 14 ? 'PJ' : 'PF',
                   nome, telefone, telefone, documento ? 0 : 1).lastInsertRowid;
          }
          aplicarContato(db, pessoaId, { email, aceite: aceitePromocoes, fonte: 'catalogo' });

          const numero = gerarNumero(db, 'pedido');
          /* `tipo = 'catalogo'` é definido AQUI, e não aceito do corpo:
             `ORIGENS_CLIENTE` não inclui 'catalogo' justamente para que a
             procedência não possa ser forjada por quem chama a rota. */
          /* `tipoOperacaoId` entra no INSERT, e não num UPDATE depois: a
             confirmação logo abaixo consulta a natureza para decidir se
             reserva estoque, e um pedido que existisse por um instante sem
             ela seria reservado pelo fallback antes de a natureza chegar. */
          const pedidoId = db.prepare(`INSERT INTO pedidos
              (numero, tipo, modoDocumento, clienteId, status, dataPedido, observacao,
               depositoId, tipoAtendimento, meioPagamento, tipoFrete, valorFrete,
               enderecoEntrega, numeroEntrega, complementoEntrega, bairroEntrega,
               cidadeEntrega, ufEntrega, cepEntrega, contatoEntrega, telefoneEntrega,
               idempotenciaChave, tipoOperacaoId)
            VALUES (?, 'catalogo', 'pedido', ?, 'rascunho', ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            /* `date('now','-3 hours')` é como o resto deste arquivo grava data:
               o ERP inteiro usa a hora de Brasília e não há timezone por tenant. */
            .run(numero, pessoaId, dataDeHojeBrasilia(), observacao, resolverDeposito(db, {}),
                 atendimento, PAGAMENTOS_CHECKOUT[pagamento],
                 atendimento === 'entrega' ? 'CIF' : null, frete,
                 end && end.logradouro, end && end.numero, end && end.complemento,
                 end && end.bairro, end && end.cidade, end && end.uf, end && end.cep,
                 nome, telefone, chave, natureza.id).lastInsertRowid;

          const ins = db.prepare(`INSERT INTO pedido_itens
              (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
            VALUES (?, ?, ?, ?, ?, ?)`);
          for (const i of itens) {
            const itemId = ins.run(pedidoId, i.produtoId, descricaoDoItem(i), i.quantidade,
                    i.precoUnitario, i.total).lastInsertRowid;
            gravarEscolhasDoItem(db, pedidoId, itemId, i);
            // As flores e o papel da montagem, como insumo do item.
            if (i.componentes) montagem.gravarComponentes(db, pedidoId, itemId, i.componentes);
          }
          recalcularTotal(db, pedidoId);
          // A data desejada da montagem vira a entrega prevista (a mais cedo).
          const datas = itens.map((i) => i.dataDesejada).filter(Boolean).sort();
          if (datas.length) db.prepare('UPDATE pedidos SET dataEntregaPrevista = ? WHERE id = ?').run(datas[0], pedidoId);
          const token = pagamentoLoja.registrarPedido(db, pedidoId, { freteACombinar });

          /* A MESMA confirmação do ERP: valida cliente, itens, atendimento,
             alçada e estoque, e cria a reserva. Devolve `{ok:false}` em vez
             de lançar, então o erro vira exceção aqui — é ela que desfaz a
             transação inteira. */
          const conf = confirmarPedidoInterno(pedidoId, {});
          if (!conf.ok) {
            const e = new Error('CONFIRMACAO');
            e.detalhe = conf;
            throw e;
          }
          return { id: pedidoId, numero, token };
        })();
      } catch (e) {
        /* Corrida: a outra requisição criou o pedido entre a consulta e o
           INSERT. A constraint é quem pegou — e é para isso que ela existe. */
        if (/UNIQUE constraint failed: pedidos.idempotenciaChave/i.test(e.message || '')) {
          const dela = db.prepare(
            'SELECT id, numero FROM pedidos WHERE idempotenciaChave = ?').get(chave);
          if (dela) return responderExistente(res, dela, impressao);
          return recusa(409, 'Seu pedido já está sendo processado. Aguarde um instante.');
        }
        if (e.message === 'CONFIRMACAO') {
          const d = e.detalhe || {};
          if (d.insuficiencias && d.insuficiencias.length) {
            const nomes = d.insuficiencias
              .map((x) => x.sku || x.descricao).filter(Boolean).slice(0, 5);
            return recusa(409, nomes.length
              ? `Alguns itens não têm mais a quantidade pedida: ${nomes.join(', ')}. Ajuste a sacola e tente de novo.`
              : 'Alguns itens não têm mais a quantidade pedida. Ajuste a sacola e tente de novo.');
          }
          return recusa(409, 'Não foi possível concluir o pedido agora. Tente novamente em instantes.');
        }
        throw e;
      }

      /* O Pix nasce DEPOIS do commit: é chamada de rede ao provedor, e o
         pedido já existe e vale mesmo que ela falhe. Nesse caso o cliente fica
         sabendo que a loja manda o Pix, e a tela do pedido gera de novo. */
      let pixErro = null;
      if (pixNoSite && !freteACombinar && total > 0) {
        try { await pagamentoLoja.emitirPixDoPedido(db, criado.id, { vencimentoDias: c.pagamentoVencimentoDias ?? 1 }); }
        catch (e) { pixErro = e.message; console.error(`[loja] Pix do pedido ${criado.numero}:`, e.message); }
      }

      const p = db.prepare('SELECT numero, valorTotal FROM pedidos WHERE id = ?').get(criado.id);
      return res.json({
        success: true,
        numero: p.numero,
        total: r2c(p.valorTotal),
        subtotal, frete,
        atendimento,
        pagamento: { codigo: pagamento, rotulo: ROTULO_PAGAMENTO[pagamento] },
        whatsapp: whatsappNormalizado(c.whatsapp || (empresaDe(db) || {}).telefone),
        freteACombinar,
        pixNoSite,
        link: criado.token,
        cobranca: pixNoSite ? pagamentoLoja.estadoDoPedido(db, criado.id) : null,
        pixFalhou: !!pixErro,
      });
    } catch (e) {
      /* Nada do erro real vai para a rua: ele pode carregar SQL, nome de
         coluna ou dado de outro cliente. O log fica do lado de cá. */
      console.error('[loja] finalizar pedido:', e.message);
      return res.status(500).json({ success: false,
        error: 'Não conseguimos concluir seu pedido agora. Tente de novo em instantes.' });
    }
  });

  /**
   * GET /loja/api/sugestoes — o "Complete seu pedido".
   *
   * Regra simples e declarada, como pedido: destaques primeiro, depois quem
   * divide categoria com o que já está na sacola, depois o resto. Nada de
   * algoritmo de recomendação — o que existe aqui é ordem de preferência, não
   * inteligência, e vale mais ser previsível do que esperto.
   *
   * Nunca sugere o que já está no carrinho: repetir o que a pessoa acabou de
   * escolher é o jeito mais rápido de a seção parecer quebrada.
   */
  app.get('/loja/api/sugestoes', (req, res) => {
    try {
      const c = lerConfig(db);
      if (!c.ativa) return res.status(404).json({ success: false, error: 'Loja não publicada' });

      const noCarrinho = String(req.query.excluir || '')
        .split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
      const cats = String(req.query.categorias || '').split('|').map((s) => s.trim()).filter(Boolean);
      const limite = Math.min(12, Math.max(1, Number(req.query.limite) || 8));

      const linhas = db.prepare(`SELECT id, sku, descricao, marca, categoria, unidade, precoVenda, imagemPath,
          COALESCE(destaqueNaLoja, 0) AS destaque
        FROM produtos WHERE ativo = 1 AND publicadoNaLoja = 1`).all();

      const pessoaId = pessoaLogada(req);
      const candidatos = linhas
        .filter((p) => !noCarrinho.includes(p.id))
        .map((p) => ({ p, peso: p.destaque ? 0 : (cats.includes(String(p.categoria || '')) ? 1 : 2) }))
        .sort((a, b) => a.peso - b.peso
          || String(a.p.descricao).localeCompare(String(b.p.descricao), 'pt-BR'))
        .slice(0, limite);

      res.json({ success: true, produtos: candidatos.map(({ p }) => {
        /* Montável aqui é o mesmo card da vitrine: leva ao montador e mostra o
           menor preço da tabela. Sem isto, a sugestão do buquê saía por
           R$ 0,00 — o `precoVenda` do cadastro, que nos montáveis não é
           usado para nada. */
        if (montagem.ehMontavel(db, p.id)) {
          return { id: p.id, sku: p.sku, descricao: p.descricao, marca: marcaVisivel(p.marca),
                   categoria: p.categoria, unidade: p.unidade, destaque: !!p.destaque,
                   montavel: true, preco: c.mostrarPreco ? montagem.precoInicial(db, p.id) : null,
                   precoAnterior: null, temPersonalizacao: true,
                   fotos: fotosDe(p.id, p.imagemPath) };
        }
        const preco = precoVisivel(c, p, pessoaId);
        return { id: p.id, sku: p.sku, descricao: p.descricao, marca: marcaVisivel(p.marca),
                 categoria: p.categoria, unidade: p.unidade, destaque: !!p.destaque,
                 preco, precoAnterior: precoAnterior(c, p, preco),
                 temPersonalizacao: personalizacoesDe(db, p.id).length > 0,
                 fotos: fotosDe(p.id, p.imagemPath) };
      }) });
    } catch (e) { return erroInterno(res, '/loja/api/sugestoes', e); }
  });
}

// ==================== ADMIN (dentro do ERP) ====================

const uploadLogo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

function registrarRotasLojaAdmin(app, db) {
  migrarLojaDB(db);
  montagem.registrarRotasMontagemAdmin(app, db);       // /api/loja/montagem
  pagamentoLoja.registrarRotasPagamentoAdmin(app, db); // /api/pedidos/:id/pix

  app.get('/api/loja/config', (req, res) => {
    try {
      const c = lerConfig(db);
      const publicados = db.prepare('SELECT COUNT(*) n FROM produtos WHERE ativo = 1 AND publicadoNaLoja = 1').get().n;
      const semFoto = db.prepare(`SELECT COUNT(*) n FROM produtos p WHERE p.ativo = 1 AND p.publicadoNaLoja = 1
        AND COALESCE(p.imagemPath,'') = ''
        AND NOT EXISTS (SELECT 1 FROM produto_imagens i WHERE i.produtoId = p.id)`).get().n;
      // Pedido da loja nasce em rascunho e fica esperando conferência: se
      // ninguém olhar, o comprador espera e o estoque segue reservado.
      let aguardando = 0;
      try {
        aguardando = db.prepare(`SELECT COUNT(*) n FROM pedidos
          WHERE COALESCE(origemLoja,0) = 1 AND status = 'rascunho'`).get().n;
      } catch { /* base ainda sem a coluna */ }
      /* As naturezas vão junto porque a tela de Regras Fiscais é um SELECT: o
         lojista escolhe entre as que já existem no ERP e nunca digita uma.
         Vão os três campos de efeito (`emiteNFe`, `geraFinanceiro`,
         `movimentaEstoque`) para a tela poder DESCREVER o que a escolha faz —
         ler, não guardar. Quem decide continua sendo a natureza. */
      let naturezas = [];
      try {
        naturezas = db.prepare(`SELECT id, codigo, descricao, emiteNFe, geraFinanceiro,
            movimentaEstoque, usarEmPedido
          FROM tipos_operacao WHERE ativo = 1 ORDER BY codigo`).all();
      } catch { /* tenant sem a tabela ainda: a tela mostra a lista vazia */ }
      res.json({ success: true, config: c, presets: PRESETS, opcoesTema: OPCOES_TEMA, naturezas,
                 resumo: { publicados, semFoto, aguardando },
                 url: `${req.protocol}://${req.get('host')}/loja/` });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.put('/api/loja/config', (req, res) => {
    try {
      const b = req.body || {};
      const atual = lerConfig(db);
      const tema = { ...atual.tema, ...(b.tema || {}) };
      if (!/^#[0-9a-f]{6}$/i.test(String(tema.corPrimaria || ''))) {
        return res.status(400).json({ success: false, error: 'Cor principal deve estar no formato #RRGGBB' });
      }
      // Cores opcionais: vazio desliga, e qualquer outra coisa que não seja
      // #RRGGBB é recusada, porque o valor vai direto para o CSS da vitrine.
      for (const [campo, nome] of [['corSecundaria', 'Cor secundária'], ['corTema', 'Cor da barra do navegador'],
                                   ['corFundo', 'Cor do fundo'], ['corApoio', 'Cor de apoio']]) {
        if (tema[campo] == null || tema[campo] === '') { tema[campo] = null; continue; }
        if (!/^#[0-9a-f]{6}$/i.test(String(tema[campo]))) {
          return res.status(400).json({ success: false, error: `${nome} deve estar no formato #RRGGBB` });
        }
      }
      tema.raio = Math.max(0, Math.min(32, Number(tema.raio) || 0));
      if (!OPCOES_TEMA.fundo.includes(tema.fundo)) tema.fundo = 'claro';
      if (!OPCOES_TEMA.fonte.includes(tema.fonte)) tema.fonte = 'neutra';
      if (!OPCOES_TEMA.fonteTitulo.includes(tema.fonteTitulo)) tema.fonteTitulo = 'igual';
      if (!OPCOES_TEMA.fundoEfeito.includes(tema.fundoEfeito)) tema.fundoEfeito = 'liso';
      if (!OPCOES_TEMA.sombra.includes(tema.sombra)) tema.sombra = 'nenhuma';
      if (!OPCOES_TEMA.topo.includes(tema.topo)) tema.topo = 'solido';
      tema.sigla = tema.sigla == null ? null : String(tema.sigla).trim().slice(0, 3) || null;
      tema.slogan = tema.slogan == null ? null : String(tema.slogan).trim().slice(0, 40) || null;
      tema.destaque = lerDestaque(tema.destaque);
      tema.faixaTexto = tema.faixaTexto == null ? null : String(tema.faixaTexto).trim().slice(0, 140) || null;

      const modo = MODOS_PAGAMENTO.includes(b.pagamentoModo) ? b.pagamentoModo : (atual.pagamentoModo || 'nenhum');
      const venc = Math.max(0, Math.min(60, Number(b.pagamentoVencimentoDias ?? atual.pagamentoVencimentoDias ?? 3)));
      db.prepare('UPDATE loja_config SET pagamentoModo=?, pagamentoVencimentoDias=? WHERE id=1').run(modo, venc);

      const txt = (v, max) => v == null ? null : String(v).trim().slice(0, max) || null;

      /* CAMPO AUSENTE NÃO É CAMPO VAZIO.
       *
       * Esta rota grava a linha inteira, e até 19/09 quem não mandasse um campo
       * o perdia: `txt(undefined)` devolve `null` e `b.ativa ? 1 : 0` devolve 0.
       * Na prática, salvar a aparência apagava o e-mail e o telefone digitados
       * em "Informações da empresa", e uma tela que mandasse só o preço tirava
       * o catálogo do ar.
       *
       * `whatsapp`, `pagamentoModo` e `pagamentoVencimentoDias` já tinham essa
       * proteção; o resto não tinha, e a diferença era descuido, não decisão.
       * Agora vale para todos: ausente preserva, enviado aplica a regra normal
       * de sempre — inclusive enviar vazio, que continua limpando o campo. */
      const enviado = (campo) => Object.prototype.hasOwnProperty.call(b, campo);
      const texto = (campo, max) => (enviado(campo) ? txt(b[campo], max) : atual[campo]);
      const liga = (campo) => (enviado(campo) ? (b[campo] ? 1 : 0) : (atual[campo] ? 1 : 0));

      db.prepare(`UPDATE loja_config SET ativa=?, nome=?, descricao=?, whatsapp=?, email=?, telefone=?,
          mostrarPreco=?, mostrarEstoque=?, tema=?, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=1`)
        .run(liga('ativa'), texto('nome', 80), texto('descricao', 300),
             // Só dígitos no WhatsApp: o link do wa.me não aceita máscara.
             b.whatsapp != null ? String(b.whatsapp).replace(/\D/g, '').slice(0, 15) || null : atual.whatsapp,
             texto('email', 120), texto('telefone', 40),
             liga('mostrarPreco'), liga('mostrarEstoque'), JSON.stringify(tema));
      db.prepare('UPDATE loja_config SET rodapeTexto=?, paginaInicial=? WHERE id=1')
        .run(texto('rodapeTexto', 200), liga('paginaInicial'));
      esquecerVitrine(req);

      /* ── Regras fiscais: só a REFERÊNCIA, sempre validada aqui ───────────
       *
       * O id que chega é entrada não confiável como qualquer outra. A busca é
       * feita no banco do tenant da requisição, então id de outra empresa não
       * é encontrado e a gravação é recusada — não há como um tenant apontar
       * para a natureza de outro.
       *
       * Vazio é permitido e significa "não configurado": é assim que o lojista
       * desfaz a escolha. O checkout recusa pedido nesse estado, e é isso que
       * se quer — melhor não vender do que vender sem saber o que a venda
       * movimenta.
       *
       * Para a natureza da NFC-e, `emiteNFe = 1` é exigido: uma natureza que
       * não emite documento fiscal não pode ser a natureza de um documento
       * fiscal. Isso não é regra inventada aqui — é o mesmo teste que o
       * emissor já faz antes de montar o XML.
       *
       * Para a natureza do PEDIDO nada é exigido além de existir e estar
       * ativa. `geraFinanceiro`, `movimentaEstoque` e `emiteNFe` são a decisão
       * que o lojista está tomando ao escolhê-la. */
      const naturezaValida = (campo, exigirEmissao) => {
        if (!enviado(campo)) return { manter: true };
        const bruto = b[campo];
        if (bruto == null || bruto === '') return { valor: null };
        const id = Number(bruto);
        if (!Number.isInteger(id) || id <= 0) return { erro: 'Natureza de operação inválida.' };
        const nat = db.prepare('SELECT id, descricao, ativo, emiteNFe FROM tipos_operacao WHERE id = ?').get(id);
        if (!nat) return { erro: 'Natureza de operação não encontrada nesta empresa.' };
        if (Number(nat.ativo) === 0) return { erro: `A natureza "${nat.descricao}" está inativa.` };
        if (exigirEmissao && !Number(nat.emiteNFe)) {
          return { erro: `A natureza "${nat.descricao}" não emite documento fiscal — `
            + 'escolha uma que emita para usar na NFC-e.' };
        }
        return { valor: nat.id };
      };

      const natPedido = naturezaValida('tipoOperacaoPedidoId', false);
      if (natPedido.erro) return res.status(400).json({ success: false, error: natPedido.erro });
      const natNfce = naturezaValida('tipoOperacaoNfceId', true);
      if (natNfce.erro) return res.status(400).json({ success: false, error: natNfce.erro });

      if (!natPedido.manter) {
        db.prepare('UPDATE loja_config SET tipoOperacaoPedidoId=? WHERE id=1').run(natPedido.valor);
      }
      if (!natNfce.manter) {
        db.prepare('UPDATE loja_config SET tipoOperacaoNfceId=? WHERE id=1').run(natNfce.valor);
      }

      res.json({ success: true, config: lerConfig(db) });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /* `reentrarContextoTenant` é OBRIGATÓRIO depois do multer.
   *
   * O AsyncLocalStorage do tenant não atravessa os callbacks de stream: o
   * busboy lê o corpo no contexto de quando o socket nasceu, que é ANTES do
   * `tenantStorage.run()`. Quando o handler roda, o store já não existe, e o
   * primeiro `db.prepare` estoura "currentDb() chamado fora de contexto de
   * tenant" — devolvido como 400, sem dizer o que aconteceu.
   *
   * Reproduzido no tenant `produtosbomgosto` em 14/09 antes desta linha existir.
   * Mesmo padrão de contas-receber, contratos, financeiro, OS e importação. */
  app.post('/api/loja/logo', uploadLogo.single('logo'), reentrarContextoTenant, (req, res) => {
    try {
      if (!req.file?.buffer) return res.status(400).json({ success: false, error: 'Envie o arquivo do logotipo' });
      // Assinatura do arquivo, não o content-type declarado — mesma regra da
      // foto de produto. Extensão mente; os primeiros bytes, não.
      const ext = imgs.tipoReal(req.file.buffer);
      if (!ext) return res.status(400).json({ success: false, error: 'O arquivo não é uma imagem JPEG, PNG, WEBP ou GIF' });
      const fs = require('fs');
      const dir = path.join(RAIZ_PUBLICA, SUBDIR_LOJA);
      fs.mkdirSync(dir, { recursive: true });
      const nome = nomeImagemLoja(req, 'logo', ext);
      fs.writeFileSync(path.join(dir, nome), req.file.buffer);
      const caminho = '/' + SUBDIR_LOJA + '/' + nome;
      // Imagem nova, enquadramento zerado: o ajuste pertencia à imagem antiga
      // e aplicá-lo à nova recortaria um pedaço que ninguém escolheu.
      db.prepare('UPDATE loja_config SET logoPath=?, logoFoco=NULL, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=1')
        .run(caminho);
      res.json({ success: true, logo: caminho });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * PUT /api/loja/enquadramento — só o ajuste, nunca a imagem.
   *
   * Separado do upload de propósito: reenquadrar não reenvia arquivo, e não
   * deve mesmo. É o que garante que o original nunca seja re-encodado.
   */
  app.put('/api/loja/enquadramento', (req, res) => {
    try {
      const qual = String(req.body?.qual || '');
      if (!['logo', 'banner'].includes(qual)) {
        return res.status(422).json({ success: false, error: 'qual: logo ou banner' });
      }
      const foco = lerFoco(req.body?.foco);
      if (!foco) return res.status(422).json({ success: false, error: 'Enquadramento inválido' });
      const coluna = qual === 'logo' ? 'logoFoco' : 'bannerFoco';
      db.prepare(`UPDATE loja_config SET ${coluna} = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = 1`)
        .run(JSON.stringify(foco));
      res.json({ success: true, foco });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.delete('/api/loja/logo', (req, res) => {
    try {
      db.prepare('UPDATE loja_config SET logoPath=NULL, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=1').run();
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /* Banner do cabeçalho — espelha o logo, inclusive na validação.
   *
   * `imgs.tipoReal()` de novo, e não o content-type: quem sobe banner sobe
   * arquivo grande vindo de qualquer lugar, e a extensão mente. */
  // Mesmo motivo da rota de logo acima: sem isto, o upload morre no primeiro
  // acesso ao db com "currentDb() chamado fora de contexto de tenant".
  app.post('/api/loja/banner', uploadLogo.single('banner'), reentrarContextoTenant, (req, res) => {
    try {
      if (!req.file?.buffer) return res.status(400).json({ success: false, error: 'Envie o arquivo do banner' });
      const ext = imgs.tipoReal(req.file.buffer);
      if (!ext) return res.status(400).json({ success: false, error: 'O arquivo não é uma imagem JPEG, PNG, WEBP ou GIF' });
      const fs = require('fs');
      const dir = path.join(RAIZ_PUBLICA, SUBDIR_LOJA);
      fs.mkdirSync(dir, { recursive: true });
      const nome = nomeImagemLoja(req, 'banner', ext);
      fs.writeFileSync(path.join(dir, nome), req.file.buffer);
      const caminho = '/' + SUBDIR_LOJA + '/' + nome;
      // Imagem nova, enquadramento zerado: o ajuste pertencia à imagem antiga
      // e aplicá-lo à nova recortaria um pedaço que ninguém escolheu.
      db.prepare('UPDATE loja_config SET bannerPath=?, bannerFoco=NULL, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=1')
        .run(caminho);
      res.json({ success: true, banner: caminho });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.delete('/api/loja/banner', (req, res) => {
    try {
      db.prepare('UPDATE loja_config SET bannerPath=NULL, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=1').run();
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /* Ícone da aba da vitrine. Mesma validação do logo (assinatura do arquivo,
   * não a extensão) e mesmo `reentrarContextoTenant` depois do multer. É ele
   * que a vitrine declara no <link rel="icon">, e é para ele que o
   * /favicon.ico aponta quando a loja é a página inicial. */
  app.post('/api/loja/favicon', uploadLogo.single('favicon'), reentrarContextoTenant, (req, res) => {
    try {
      if (!req.file?.buffer) return res.status(400).json({ success: false, error: 'Envie a imagem do ícone' });
      const ext = imgs.tipoReal(req.file.buffer);
      if (!ext) return res.status(400).json({ success: false, error: 'O arquivo não é uma imagem JPEG, PNG, WEBP ou GIF' });
      const fs = require('fs');
      const dir = path.join(RAIZ_PUBLICA, SUBDIR_LOJA);
      fs.mkdirSync(dir, { recursive: true });
      const nome = nomeImagemLoja(req, 'favicon', ext);
      fs.writeFileSync(path.join(dir, nome), req.file.buffer);
      const caminho = '/' + SUBDIR_LOJA + '/' + nome;
      db.prepare('UPDATE loja_config SET faviconPath=?, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=1').run(caminho);
      esquecerVitrine(req);
      res.json({ success: true, favicon: caminho });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.delete('/api/loja/favicon', (req, res) => {
    try {
      db.prepare('UPDATE loja_config SET faviconPath=NULL, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=1').run();
      esquecerVitrine(req);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /* ===================== PERSONALIZAÇÕES (grupos e opções) =====================
   *
   * As mesmas tabelas que o cardápio do restaurante usa (rest_grupos_opcao,
   * rest_opcoes, rest_produto_grupos), fora do módulo Restaurante: qualquer loja
   * cadastra "Tamanho", "Embalagem", "Fita" e "Mensagem do cartão" sem ligar o
   * restaurante. As rotas do restaurante continuam como estão; estas aceitam
   * também o grupo de TEXTO (campo livre) e a pergunta do grupo, que a vitrine
   * já sabia mostrar e ninguém conseguia cadastrar.
   *
   * O insumo da opção é o produto que sai do estoque quando ela é escolhida
   * (ver gravarEscolhasDoItem e reservas-routes.explodirItensPedido). */
  const validarGrupo = (b, atual = {}) => {
    const tipo = b.tipo !== undefined ? String(b.tipo) : (atual.tipo || 'escolha');
    if (!['escolha', 'texto'].includes(tipo)) return { erro: 'Tipo deve ser escolha ou texto' };
    const nome = b.nome !== undefined ? String(b.nome).trim().slice(0, 80) : atual.nome;
    if (!nome) return { erro: 'Dê um nome ao grupo' };
    let min = b.minEscolhas !== undefined ? Number(b.minEscolhas) : (atual.minEscolhas ?? 0);
    let max = b.maxEscolhas !== undefined ? Number(b.maxEscolhas) : (atual.maxEscolhas ?? 1);
    if (tipo === 'texto') { min = min > 0 ? 1 : 0; max = 1; }
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1) return { erro: 'Mínimo e máximo inválidos' };
    if (min > max) return { erro: 'O mínimo não pode ser maior que o máximo' };
    const descricao = b.descricao !== undefined ? (String(b.descricao).trim().slice(0, 160) || null) : (atual.descricao ?? null);
    return { tipo, nome, min, max, descricao };
  };
  const validarInsumo = (b) => {
    if (!b.insumoProdutoId) return { insumo: null, qtd: null };
    const p = db.prepare('SELECT id, tipoProduto FROM produtos WHERE id = ?').get(Number(b.insumoProdutoId));
    if (!p) return { erro: 'Insumo não encontrado' };
    if (p.tipoProduto === 'kit') return { erro: 'Um kit não pode ser insumo de opção: escolha os componentes' };
    const qtd = b.quantidadeInsumo == null || b.quantidadeInsumo === '' ? 1 : Number(b.quantidadeInsumo);
    if (!(qtd > 0)) return { erro: 'A quantidade do insumo precisa ser maior que zero' };
    return { insumo: p.id, qtd };
  };

  app.get('/api/loja/opcoes/grupos', (req, res) => {
    try {
      const grupos = db.prepare(`SELECT id, nome, descricao, COALESCE(tipo,'escolha') tipo, minEscolhas, maxEscolhas, ordem, ativo
        FROM rest_grupos_opcao ORDER BY ordem, nome`).all();
      const opcoes = db.prepare(`SELECT o.id, o.grupoId, o.nome, o.precoAdicional, o.insumoProdutoId, o.quantidadeInsumo,
          o.ordem, o.ativo, p.sku AS insumoSku, p.descricao AS insumoDescricao
        FROM rest_opcoes o LEFT JOIN produtos p ON p.id = o.insumoProdutoId ORDER BY o.ordem, o.id`).all();
      const usos = db.prepare('SELECT grupoId, COUNT(*) n FROM rest_produto_grupos GROUP BY grupoId').all();
      const uso = new Map(usos.map(u => [u.grupoId, u.n]));
      for (const g of grupos) { g.opcoes = opcoes.filter(o => o.grupoId === g.id); g.produtos = uso.get(g.id) || 0; }
      res.json({ success: true, grupos });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/loja/opcoes/grupos', (req, res) => {
    try {
      const v = validarGrupo(req.body || {});
      if (v.erro) return res.status(400).json({ success: false, error: v.erro });
      const r = db.prepare(`INSERT INTO rest_grupos_opcao (nome, descricao, tipo, minEscolhas, maxEscolhas, ordem, ativo)
        VALUES (?, ?, ?, ?, ?, ?, 1)`).run(v.nome, v.descricao, v.tipo, v.min, v.max, Number(req.body?.ordem) || 0);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.put('/api/loja/opcoes/grupos/:id', (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM rest_grupos_opcao WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Grupo não encontrado' });
      const v = validarGrupo(req.body || {}, atual);
      if (v.erro) return res.status(400).json({ success: false, error: v.erro });
      const b = req.body || {};
      db.prepare(`UPDATE rest_grupos_opcao SET nome=?, descricao=?, tipo=?, minEscolhas=?, maxEscolhas=?, ordem=?, ativo=? WHERE id=?`)
        .run(v.nome, v.descricao, v.tipo, v.min, v.max,
             b.ordem !== undefined ? Number(b.ordem) || 0 : atual.ordem,
             b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo, atual.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.delete('/api/loja/opcoes/grupos/:id', (req, res) => {
    try {
      const n = db.prepare('SELECT COUNT(*) n FROM rest_produto_grupos WHERE grupoId = ?').get(req.params.id).n;
      if (n > 0) return res.status(400).json({ success: false, error: `O grupo está em ${n} produto(s). Tire dos produtos antes de apagar.` });
      db.transaction(() => {
        db.prepare('DELETE FROM rest_opcoes WHERE grupoId = ?').run(req.params.id);
        db.prepare('DELETE FROM rest_grupos_opcao WHERE id = ?').run(req.params.id);
      })();
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/loja/opcoes/grupos/:id/opcoes', (req, res) => {
    try {
      const g = db.prepare("SELECT id, COALESCE(tipo,'escolha') tipo FROM rest_grupos_opcao WHERE id = ?").get(req.params.id);
      if (!g) return res.status(404).json({ success: false, error: 'Grupo não encontrado' });
      if (g.tipo === 'texto') return res.status(400).json({ success: false, error: 'Grupo de texto não tem opções' });
      const b = req.body || {};
      const nome = String(b.nome || '').trim().slice(0, 80);
      if (!nome) return res.status(400).json({ success: false, error: 'Dê um nome à opção' });
      const preco = b.precoAdicional == null || b.precoAdicional === '' ? 0 : Number(b.precoAdicional);
      if (!Number.isFinite(preco) || preco < 0) return res.status(400).json({ success: false, error: 'Preço adicional inválido' });
      const ins = validarInsumo(b);
      if (ins.erro) return res.status(400).json({ success: false, error: ins.erro });
      const r = db.prepare(`INSERT INTO rest_opcoes (grupoId, nome, precoAdicional, insumoProdutoId, quantidadeInsumo, ordem, ativo)
        VALUES (?, ?, ?, ?, ?, ?, 1)`).run(g.id, nome, r2c(preco), ins.insumo, ins.qtd, Number(b.ordem) || 0);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.put('/api/loja/opcoes/itens/:id', (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM rest_opcoes WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Opção não encontrada' });
      const b = req.body || {};
      const nome = b.nome !== undefined ? String(b.nome).trim().slice(0, 80) : atual.nome;
      if (!nome) return res.status(400).json({ success: false, error: 'Dê um nome à opção' });
      const preco = b.precoAdicional !== undefined ? Number(b.precoAdicional) : Number(atual.precoAdicional);
      if (!Number.isFinite(preco) || preco < 0) return res.status(400).json({ success: false, error: 'Preço adicional inválido' });
      let insumo = atual.insumoProdutoId, qtd = atual.quantidadeInsumo;
      if (b.insumoProdutoId !== undefined) {
        const ins = validarInsumo(b);
        if (ins.erro) return res.status(400).json({ success: false, error: ins.erro });
        insumo = ins.insumo; qtd = ins.qtd;
      }
      db.prepare('UPDATE rest_opcoes SET nome=?, precoAdicional=?, insumoProdutoId=?, quantidadeInsumo=?, ordem=?, ativo=? WHERE id=?')
        .run(nome, r2c(preco), insumo, qtd,
             b.ordem !== undefined ? Number(b.ordem) || 0 : atual.ordem,
             b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo, atual.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.delete('/api/loja/opcoes/itens/:id', (req, res) => {
    try {
      db.prepare('DELETE FROM rest_opcoes WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/loja/opcoes/produto/:id', (req, res) => {
    try {
      const ids = db.prepare('SELECT grupoId FROM rest_produto_grupos WHERE produtoId = ? ORDER BY ordem').all(req.params.id)
        .map(r => r.grupoId);
      res.json({ success: true, grupoIds: ids });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Substitui o conjunto inteiro, na ordem enviada (é a ordem na vitrine).
  app.put('/api/loja/opcoes/produto/:id', (req, res) => {
    try {
      const p = db.prepare('SELECT id FROM produtos WHERE id = ?').get(req.params.id);
      if (!p) return res.status(404).json({ success: false, error: 'Produto não encontrado' });
      const ids = Array.isArray(req.body?.grupoIds) ? [...new Set(req.body.grupoIds.map(Number))] : null;
      if (!ids) return res.status(400).json({ success: false, error: 'grupoIds deve ser uma lista' });
      for (const gid of ids) {
        if (!db.prepare('SELECT 1 FROM rest_grupos_opcao WHERE id = ?').get(gid)) {
          return res.status(404).json({ success: false, error: `Grupo ${gid} não encontrado` });
        }
      }
      db.transaction(() => {
        db.prepare('DELETE FROM rest_produto_grupos WHERE produtoId = ?').run(p.id);
        const ins = db.prepare('INSERT INTO rest_produto_grupos (produtoId, grupoId, ordem) VALUES (?, ?, ?)');
        ids.forEach((gid, i) => ins.run(p.id, gid, i));
      })();
      res.json({ success: true, vinculados: ids.length });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  /* Nome da loja, isolado do PUT /api/loja/config.
   *
   * O PUT grava a configuração INTEIRA de uma vez: mandar só o nome por ele
   * apagaria whatsapp, e-mail, descrição e os dois "mostrar". O cabeçalho edita
   * um campo só, então precisa de uma rota que escreva um campo só.
   *
   * Nome vazio não vira string vazia, vira NULL — é o que devolve o recuo para
   * a razão social do emitente em vez de deixar o cabeçalho em branco. */
  app.put('/api/loja/nome', (req, res) => {
    try {
      const nome = String(req.body?.nome ?? '').trim().slice(0, 80) || null;
      db.prepare('UPDATE loja_config SET nome=?, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=1').run(nome);
      res.json({ success: true, nome });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /* Publicar / despublicar a loja — mesmo motivo do de cima: escreve `ativa` e
   * mais nada. É o interruptor do cabeçalho, e ele não pode ter efeito colateral
   * sobre o resto da configuração. */
  app.post('/api/loja/publicar', (req, res) => {
    try {
      const ativa = req.body?.ativa ? 1 : 0;
      db.prepare('UPDATE loja_config SET ativa=?, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=1').run(ativa);
      esquecerVitrine(req);
      res.json({ success: true, ativa: !!ativa });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * GET/PUT /api/loja/informacoes — a tela "Informações da empresa".
   *
   * O GET devolve o que está gravado E o que a empresa oferece como fallback,
   * separados: é isso que permite a tela mostrar "usando o nome da empresa" em
   * vez de um campo vazio que parece defeito.
   *
   * O PUT grava SÓ estes campos. Não usa o `PUT /api/loja/config`, que reescreve
   * a configuração inteira — mandar por lá apagaria tema e pagamento, que esta
   * tela nem exibe.
   */
  app.get('/api/loja/informacoes', (req, res) => {
    try {
      const c = lerConfig(db);
      const emp = empresaDe(db);
      res.json({ success: true,
        informacoes: {
          nome: c.nome || null, descricao: c.descricao || null,
          whatsapp: c.whatsapp || null, email: c.email || null, telefone: c.telefone || null,
          instagram: c.instagram || null, facebook: c.facebook || null,
          endereco: c.endereco || null, mostrarEndereco: !!c.mostrarEndereco,
          horarios: lerHorarios(c.horarios),
          paginaInicial: !!c.paginaInicial,
        },
        enderecoRaiz: `${req.protocol}://${req.get('host')}/`,
        // O que a vitrine usaria se o campo acima ficasse vazio.
        empresa: { nome: emp.nome || null, telefone: emp.telefone || null,
                   endereco: emp.endereco || null, temLogo: !!emp.logo },
        atendimento: statusAtendimento(c.horarios),
      });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.put('/api/loja/informacoes', (req, res) => {
    try {
      const b = req.body || {};
      const txt = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);

      /* Rede social é validada na ENTRADA e de novo na saída pública.
         Duas vezes de propósito: gravar lixo e filtrar depois deixaria o lixo no
         banco para o próximo consumidor descobrir. Valor inválido é recusado
         com o motivo, não silenciosamente ignorado. */
      for (const [campo, dominio] of [['instagram', 'instagram.com'], ['facebook', 'facebook.com']]) {
        const bruto = b[campo];
        if (bruto != null && String(bruto).trim() && !usuarioRede(bruto, dominio)) {
          return res.status(422).json({ success: false,
            error: `${campo}: informe o nome de usuário (letras, números, ponto, hífen), não um endereço completo` });
        }
      }

      const horarios = lerHorarios(b.horarios);

      db.prepare(`UPDATE loja_config SET nome=?, descricao=?, whatsapp=?, email=?, telefone=?,
          instagram=?, facebook=?, endereco=?, mostrarEndereco=?, horarios=?,
          dataAtualizacao=CURRENT_TIMESTAMP WHERE id=1`)
        .run(txt(b.nome, 80), txt(b.descricao, 300),
             b.whatsapp != null ? String(b.whatsapp).replace(/\D/g, '').slice(0, 15) || null : null,
             txt(b.email, 120), txt(b.telefone, 40),
             usuarioRede(b.instagram, 'instagram.com'), usuarioRede(b.facebook, 'facebook.com'),
             txt(b.endereco, 200), b.mostrarEndereco ? 1 : 0,
             Object.keys(horarios).length ? JSON.stringify(horarios) : null);
      // Ausente preserva: quem chamar esta rota sem o campo não desliga a loja
      // como página inicial por acidente.
      if (b.paginaInicial !== undefined) {
        db.prepare('UPDATE loja_config SET paginaInicial=? WHERE id=1').run(b.paginaInicial ? 1 : 0);
      }
      esquecerVitrine(req);

      const c = lerConfig(db);
      res.json({ success: true, atendimento: statusAtendimento(c.horarios),
                 horarios: lerHorarios(c.horarios) });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * GET/PUT /api/loja/entrega — serviços, frete e cobertura.
   *
   * Separado de `/api/loja/informacoes` porque são duas telas e dois assuntos:
   * misturar faria um salvar apagar o outro, que foi o motivo de `/config` ter
   * sido evitado nas duas.
   */
  app.get('/api/loja/entrega', (req, res) => {
    try {
      const c = lerConfig(db);
      res.json({ success: true,
        entrega: {
          retirada: !!c.servicoRetirada,
          delivery: !!c.servicoDelivery,
          freteModo: MODOS_FRETE.includes(c.freteModo) ? c.freteModo : 'gratis',
          freteValor: r2c(c.freteValor),
          aceitaForaCobertura: !!c.aceitaForaCobertura,
        },
        // A tela precisa ver os inativos para poder reativá-los.
        bairros: bairrosCobertura(db, { somenteAtivos: false }) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.put('/api/loja/entrega', (req, res) => {
    try {
      const b = req.body || {};
      const modo = MODOS_FRETE.includes(b.freteModo) ? b.freteModo : 'gratis';

      /* Pelo menos um serviço tem de ficar de pé.
       *
       * Um catálogo publicado sem retirada E sem entrega aceita pedido que
       * ninguém sabe como cumprir. A recusa é explícita para o lojista saber o
       * que fazer; desligar o catálogo é outra ação, na tela do cabeçalho. */
      const retirada = !!b.retirada, delivery = !!b.delivery;
      if (!retirada && !delivery) {
        return res.status(422).json({ success: false,
          error: 'Deixe ao menos um serviço habilitado: retirada ou delivery. '
               + 'Para tirar o catálogo do ar, use "Não publicado" no cabeçalho.' });
      }

      // Frete negativo é dinheiro voltando para o cliente — nunca foi pedido.
      const valor = r2c(b.freteValor);
      if (!(valor >= 0)) {
        return res.status(422).json({ success: false, error: 'A taxa fixa não pode ser negativa' });
      }

      db.prepare(`UPDATE loja_config SET servicoRetirada=?, servicoDelivery=?, freteModo=?,
          freteValor=?, aceitaForaCobertura=?, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=1`)
        .run(retirada ? 1 : 0, delivery ? 1 : 0, modo, modo === 'fixo' ? valor : 0,
             b.aceitaForaCobertura ? 1 : 0);

      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * Bairros de cobertura — CRUD sobre `rest_bairros_taxa`.
   *
   * A tabela é compartilhada com o módulo Restaurante (ver `bairrosCobertura`).
   * Isso é deliberado: são os mesmos bairros e as mesmas taxas do mesmo negócio,
   * e manter duas listas faria o lojista atualizar uma e esquecer a outra.
   */
  app.post('/api/loja/bairros', (req, res) => {
    try {
      const nome = String(req.body?.nome || '').trim().slice(0, 80);
      const taxa = r2c(req.body?.taxa);
      if (!nome) return res.status(422).json({ success: false, error: 'Informe o nome do bairro' });
      if (!(taxa >= 0)) return res.status(422).json({ success: false, error: 'A taxa não pode ser negativa' });

      const jaTem = db.prepare('SELECT id FROM rest_bairros_taxa WHERE nome = ? COLLATE NOCASE').get(nome);
      if (jaTem) return res.status(422).json({ success: false, error: `"${nome}" já está cadastrado` });

      const id = db.prepare(`INSERT INTO rest_bairros_taxa (nome, taxa, tempoEstimadoMin, ativo)
        VALUES (?,?,?,1)`).run(nome, taxa, Math.max(0, Number(req.body?.tempoEstimadoMin) || 30)).lastInsertRowid;
      res.json({ success: true, id });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.put('/api/loja/bairros/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      const atual = db.prepare('SELECT * FROM rest_bairros_taxa WHERE id = ?').get(id);
      if (!atual) return res.status(404).json({ success: false, error: 'Bairro não encontrado' });

      const nome = req.body?.nome != null ? String(req.body.nome).trim().slice(0, 80) : atual.nome;
      const taxa = req.body?.taxa != null ? r2c(req.body.taxa) : r2c(atual.taxa);
      if (!nome) return res.status(422).json({ success: false, error: 'Informe o nome do bairro' });
      if (!(taxa >= 0)) return res.status(422).json({ success: false, error: 'A taxa não pode ser negativa' });

      db.prepare(`UPDATE rest_bairros_taxa SET nome=?, taxa=?, tempoEstimadoMin=?, ativo=? WHERE id=?`)
        .run(nome, taxa,
             req.body?.tempoEstimadoMin != null
               ? Math.max(0, Number(req.body.tempoEstimadoMin) || 0) : atual.tempoEstimadoMin,
             req.body?.ativo === undefined ? atual.ativo : (req.body.ativo ? 1 : 0), id);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.delete('/api/loja/bairros/:id', (req, res) => {
    try {
      const r = db.prepare('DELETE FROM rest_bairros_taxa WHERE id = ?').run(Number(req.params.id));
      if (!r.changes) return res.status(404).json({ success: false, error: 'Bairro não encontrado' });
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /* Ordem das categorias na vitrine.
   *
   * Recebe a lista inteira na ordem desejada e regrava, em transação. Regravar
   * tudo em vez de mandar "subiu uma posição" é o que mantém a tela e o banco
   * contando a mesma coisa: com deltas, um clique perdido deixa a numeração
   * furada para sempre, e nada avisa.
   *
   * A posição começa em 1 porque `0` é o valor de quem nunca foi ordenado.
   * "Sem categoria" (null) não entra: ela é agrupamento, não categoria, e fica
   * sempre por último. */
  app.put('/api/loja/ordem-categorias', (req, res) => {
    try {
      const lista = Array.isArray(req.body?.categorias) ? req.body.categorias : null;
      if (!lista) return res.status(400).json({ success: false, error: 'Envie a lista de categorias na ordem desejada' });
      const nomes = lista
        .map((c) => (c == null ? '' : String(c).trim()))
        .filter(Boolean);
      if (!nomes.length) return res.status(400).json({ success: false, error: 'Nenhuma categoria válida na lista' });

      const stmt = db.prepare(`INSERT INTO loja_categoria_ordem (categoria, ordem, dataAtualizacao)
                               VALUES (?, ?, CURRENT_TIMESTAMP)
                               ON CONFLICT(categoria) DO UPDATE
                                 SET ordem = excluded.ordem, dataAtualizacao = CURRENT_TIMESTAMP`);
      db.transaction((ns) => { ns.forEach((n, i) => stmt.run(n, i + 1)); })(nomes);
      res.json({ success: true, ordenadas: nomes.length });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /* Ordem dos produtos DENTRO de uma categoria. Mesma regra da de cima: lista
   * inteira, transação, posição a partir de 1.
   *
   * Grava por id e não por categoria — um produto que mudou de categoria entre
   * a tela abrir e o arrastar terminar recebe a posição mesmo assim, e reaparece
   * ordenado no grupo novo. Errar aqui é reordenar o grupo errado. */
  app.put('/api/loja/ordem-produtos', (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ success: false, error: 'Envie os ids dos produtos na ordem desejada' });
      const stmt = db.prepare('UPDATE produtos SET ordemVitrine = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?');
      db.transaction((lista) => { lista.forEach((id, i) => stmt.run(i + 1, id)); })(ids);
      res.json({ success: true, ordenados: ids.length });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Lista para o lojista escolher o que vai ao ar. Traz o que decide a
  // escolha: tem foto? tem preço? tem saldo?
  app.get('/api/loja/produtos', (req, res) => {
    try {
      const filtro = String(req.query.filtro || '');
      let sql = `SELECT p.id, p.sku, p.descricao, p.marca, p.categoria, p.precoVenda,
          COALESCE(p.publicadoNaLoja,0) AS publicado, p.imagemPath,
          (SELECT COUNT(*) FROM produto_imagens i WHERE i.produtoId = p.id) AS nFotos
        FROM produtos p WHERE p.ativo = 1`;
      if (filtro === 'publicados') sql += ' AND COALESCE(p.publicadoNaLoja,0) = 1';
      if (filtro === 'fora') sql += ' AND COALESCE(p.publicadoNaLoja,0) = 0';
      sql += ' ORDER BY p.descricao LIMIT 500';
      const produtos = db.prepare(sql).all().map(p => ({
        ...p, publicado: !!p.publicado,
        temFoto: !!(p.nFotos || p.imagemPath),
        disponivel: disponivelDe(db, p.id),
      }));
      res.json({ success: true, produtos });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/loja/produtos/publicar', (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ success: false, error: 'Selecione os produtos' });
      const publicado = req.body?.publicado ? 1 : 0;
      const stmt = db.prepare('UPDATE produtos SET publicadoNaLoja = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?');
      const tx = db.transaction((lista) => { for (const id of lista) stmt.run(publicado, id); });
      tx(ids);
      res.json({ success: true, alterados: ids.length, publicado: !!publicado });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * Destacar — espelha `publicar`, sobre a coluna `destaqueNaLoja`.
   *
   * Destaque nao e categoria: o produto continua na dele e tambem aparece na
   * faixa de destaques. Ver o comentario da migration em `migrarLojaDB`.
   */
  app.post('/api/loja/produtos/destacar', (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ success: false, error: 'Selecione os produtos' });
      const destaque = req.body?.destaque ? 1 : 0;
      const stmt = db.prepare('UPDATE produtos SET destaqueNaLoja = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?');
      db.transaction((lista) => { for (const id of lista) stmt.run(destaque, id); })(ids);
      res.json({ success: true, alterados: ids.length, destaque: !!destaque });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * A central do Catalogo Online, numa resposta so.
   *
   * Identidade + contadores + produtos AGRUPADOS por categoria. Agrupar aqui e
   * nao no navegador e o que permite a tela abrir ja organizada, e e a mesma
   * consulta que alimenta os contadores — se fossem duas, elas divergiriam no
   * dia em que alguem mudasse o filtro de uma delas.
   *
   * As categorias vem do `produto_lookup` (a gestao formal, Fase 44) UNIDAS as
   * que estao em uso nos produtos. As duas coisas, porque nenhuma sozinha
   * basta: o lookup tem categorias ainda sem produto (que precisam aparecer
   * vazias, para receber o primeiro), e os produtos podem ter categoria que
   * saiu do lookup — e um produto que sumisse da tela por isso seria um
   * produto invisivel para quem administra.
   */
  app.get('/api/loja/catalogo', (req, res) => {
    try {
      const cfg = lerConfig(db);
      const produtos = db.prepare(`
        SELECT p.id, p.sku, p.descricao, p.categoria, p.unidade, p.precoVenda, p.imagemPath,
               COALESCE(p.publicadoNaLoja, 0) AS publicado,
               COALESCE(p.destaqueNaLoja, 0)  AS destaque,
               COALESCE(p.ordemVitrine, 0)    AS ordemVitrine,
               (SELECT COUNT(*) FROM produto_imagens i WHERE i.produtoId = p.id) AS nFotos
          FROM produtos p WHERE p.ativo = 1
         /* Ordem da VITRINE: quem foi posicionado a mao vem primeiro, na
            posicao escolhida; o resto segue alfabetico, como sempre foi. O
            CASE existe porque ordemVitrine = 0 significa "nunca ordenado",
            e sem ele esses produtos subiriam todos para o topo. */
         ORDER BY CASE WHEN COALESCE(p.ordemVitrine, 0) > 0 THEN 0 ELSE 1 END,
                  COALESCE(p.ordemVitrine, 0),
                  p.descricao COLLATE NOCASE`).all();

      const SEM = '\u0000';   // mesma sentinela da Venda rapida
      const catDe = (p) => (p.categoria != null ? String(p.categoria).trim() : '') || SEM;

      const grupos = new Map();
      const registrar = (nome) => {
        if (!grupos.has(nome)) grupos.set(nome, { categoria: nome === SEM ? null : nome, produtos: [] });
        return grupos.get(nome);
      };
      // Categorias cadastradas entram mesmo sem produto: e assim que se
      // enxerga a categoria recem-criada, ainda vazia.
      try {
        for (const c of db.prepare("SELECT valor FROM produto_lookup WHERE tipo='categoria' AND ativo=1").all()) {
          registrar(String(c.valor).trim());
        }
      } catch (_) { /* instalacao sem produto_lookup */ }

      for (const p of produtos) {
        registrar(catDe(p)).produtos.push({
          id: p.id, sku: p.sku, descricao: p.descricao, unidade: p.unidade,
          preco: Number(p.precoVenda) || 0,
          foto: p.imagemPath || null, nFotos: p.nFotos,
          publicado: !!p.publicado, destaque: !!p.destaque,
          ordemVitrine: p.ordemVitrine,
          disponivel: disponivelDe(db, p.id),
        });
      }

      /* Ordem das categorias, casada por NOME — categoria é texto, não entidade
         com id. Mesmo comparador da vitrine pública, de propósito. */
      const ordemCat = ordemCategorias(db);
      const cmp = compararCategorias(ordemCat);

      const categorias = [...grupos.values()]
        .map((g) => ({ ...g, ordem: g.categoria === null ? 0 : (ordemCat.get(g.categoria) || 0) }))
        .sort((a, b) => {
          if (a.categoria === null) return 1;      // "Sem categoria" por ultimo
          if (b.categoria === null) return -1;
          return cmp(a.categoria, b.categoria);
        })
        .map((g) => ({ ...g, total: g.produtos.length,
                       publicados: g.produtos.filter((p) => p.publicado).length }));

      /* Identidade com recuo para a EMPRESA.
       *
       * `loja_config` nasce vazia — o tenant só a preenche quando decide
       * publicar. Sem recuo, a central abre com "Catálogo" e um traço no lugar
       * do logo, e parece que não carregou (foi o relato de 13/09). O emitente
       * já tem razão social e logo, e é a mesma empresa.
       *
       * `nomeProprio` diz à tela o que é escolha do lojista e o que é recuo —
       * é o que permite convidar a configurar sem apagar o que já existe. */
      let emp = {};
      try { emp = db.prepare('SELECT razaoSocial, logoBase64 FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {}; }
      catch (_) { /* instalação sem emitente cadastrado */ }

      res.json({ success: true,
        loja: {
          ativa: !!cfg.ativa,
          nome: cfg.nome || emp.razaoSocial || null,
          nomeProprio: !!cfg.nome,
          descricao: cfg.descricao || null,
          logo: cfg.logoPath || emp.logoBase64 || null,
          logoProprio: !!cfg.logoPath,
          logoFoco: lerFoco(cfg.logoFoco),
          bannerFoco: lerFoco(cfg.bannerFoco),
          /* Banner NÃO recua para nada: sem imagem escolhida, o cabeçalho usa a
             faixa de cor do tema. Inventar um banner a partir do logo daria uma
             imagem esticada que ninguém pediu. */
          banner: cfg.bannerPath || null,
          whatsapp: cfg.whatsapp || null,
          tema: cfg.tema, mostrarPreco: !!cfg.mostrarPreco, mostrarEstoque: !!cfg.mostrarEstoque,
          pagamento: cfg.pagamentoModo || 'nenhum',
          url: `${req.protocol}://${req.get('host')}/loja/`,
        },
        resumo: {
          total: produtos.length,
          publicados: produtos.filter((p) => p.publicado).length,
          ocultos: produtos.filter((p) => !p.publicado).length,
          destaques: produtos.filter((p) => p.destaque).length,
          semFoto: produtos.filter((p) => !p.imagemPath && !p.nFotos).length,
          categorias: categorias.filter((c) => c.categoria !== null).length,
        },
        /* Destaque usa a MESMA linha das categorias, então precisa dos mesmos
           campos — sem `sku` e `unidade` ele aparecia como "sem SKU". Aditivo:
           nenhum consumidor perde nada. */
        destaques: produtos.filter((p) => p.destaque)
          .map((p) => ({ id: p.id, sku: p.sku, descricao: p.descricao, unidade: p.unidade,
                         preco: Number(p.precoVenda) || 0,
                         foto: p.imagemPath || null, nFotos: p.nFotos,
                         publicado: !!p.publicado, destaque: true,
                         disponivel: disponivelDe(db, p.id) })),
        categorias,
      });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
}


/* ===================== A LOJA COMO PÁGINA INICIAL =====================
 *
 * Com `paginaInicial` ligado (e a loja publicada), o endereço do tenant é a
 * loja para quem não fez login. Três pontos da cadeia de middlewares, e cada
 * um existe porque a peça seguinte, sozinha, mostraria o ERP:
 *
 *  - `vitrineAntesDoLogin`, antes do static de public/auth: `/` vai para a
 *    loja, `/login` para o login, e o favicon, os ícones, o manifest e o
 *    service worker do ERP deixam de ser servidos ao visitante (sai o favicon
 *    da loja, ou nada).
 *  - `vitrineNaBarreira`, logo antes do requireAuth: o que chegaria ao
 *    redirecionamento para /login.html recebe o 404 da loja.
 *  - `responderLojaFechada`, na suspensão do tenant: a vitrine fecha com o
 *    nome e as cores da loja, sem falar de cobrança nem de slug.
 *
 * Quem tem sessão passa direto pelas três: o dono entra por /login e, logado,
 * `/` volta a ser o painel.
 */
const CACHE_VITRINE = new Map();   // slug -> { em, v }
const VITRINE_TTL_MS = 15000;

function lerVitrineDoBanco(db) {
  try {
    const c = db.prepare(`SELECT ativa, paginaInicial, faviconPath, nome, logoPath, whatsapp, tema
      FROM loja_config WHERE id = 1`).get();
    if (!c) return null;
    return { ...c, tema: { ...TEMA_PADRAO, ...jsonOu(c.tema, {}) } };
  } catch { return null; }   // tenant sem loja_config: não há vitrine
}

/* Toda requisição do tenant passa por aqui, inclusive as do ERP: o cache de
   15 s evita uma consulta por requisição. Quem grava a configuração chama
   `esquecerVitrine`, então a mudança vale na hora para o processo que gravou. */
function vitrinePublicada(req) {
  const slug = req.tenant && req.tenant.slug;
  if (!slug || !req.tenantDb) return null;
  const agora = Date.now();
  let e = CACHE_VITRINE.get(slug);
  if (!e || agora - e.em > VITRINE_TTL_MS) {
    e = { em: agora, v: lerVitrineDoBanco(req.tenantDb) };
    CACHE_VITRINE.set(slug, e);
  }
  const v = e.v;
  return v && Number(v.ativa) === 1 ? v : null;
}

function vitrineComoInicio(req) {
  const v = vitrinePublicada(req);
  return v && Number(v.paginaInicial) === 1 ? v : null;
}

function esquecerVitrine(req) {
  if (req && req.tenant && req.tenant.slug) CACHE_VITRINE.delete(req.tenant.slug);
}

const logado = (req) => !!(req.session && req.session.userId);
const ICONES_DO_ERP = /^\/(favicon\.(ico|svg)|apple-touch-icon\.png|icone-[a-z0-9-]+\.(png|svg))$/i;
const PWA_DO_ERP = new Set(['/manifest.webmanifest', '/sw.js', '/pwa.js']);

/* Pedido feito POR uma página do ERP, e não pela loja nem digitado.
 *
 * A sessão não basta para saber isso: o navegador busca o manifest (e os
 * ícones que ele lista) SEM mandar cookie, então o dono logado chega aqui
 * igual a um visitante. Medido em 27/09: `/manifest.webmanifest` com
 * `Referer: /app.html` e sem cookie. O que distingue é quem pediu: uma tela do
 * ERP no mesmo endereço, ou o navegador atualizando o próprio service worker
 * (cabeçalho `Service-Worker: script`). A loja nunca referencia esses
 * arquivos, então nada dela passa por aqui. */
function pedidoDoErp(req) {
  if (req.headers['service-worker'] === 'script') return true;
  try {
    const r = new URL(req.headers.referer || '');
    return r.host === req.headers.host && !/^\/loja(\/|$)/.test(r.pathname);
  } catch { return false; }
}

function vitrineAntesDoLogin(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const v = vitrineComoInicio(req);
  if (!v || logado(req)) return next();
  const p = req.path;
  if (p === '/') return res.redirect(302, '/loja/');
  if (p === '/login') return res.redirect(302, '/login.html');
  // Ícones, manifest e service worker do ERP: só para as telas do ERP (o
  // login do dono e o shell). Para o visitante, o ícone da loja ou nada.
  if (ICONES_DO_ERP.test(p) || PWA_DO_ERP.has(p)) {
    if (pedidoDoErp(req)) return next();
    if (ICONES_DO_ERP.test(p) && v.faviconPath) return res.redirect(302, v.faviconPath);
    return res.status(404).end();
  }
  next();
}

const PAGINA_404 = path.join(RAIZ_PUBLICA, 'loja', '404.html');

/* Dentro de /loja/ o 404 é o da loja sempre que ela está publicada, seja ou
   não a página inicial (29/09): o endereço divulgado é o /loja/, e um link
   quebrado ali não deve levar o cliente ao login do ERP. Fora de /loja/, só
   com a loja como página inicial. */
function vitrineNaBarreira(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/') || req.headers['x-api-key']) return next();
  const v = vitrinePublicada(req);
  if (!v || logado(req)) return next();
  const naLoja = req.path === '/loja' || req.path.startsWith('/loja/');
  if (!naLoja && Number(v.paginaInicial) !== 1) return next();
  res.status(404).sendFile(PAGINA_404);
}

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const corOk = (c, padrao) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : padrao);

/**
 * Página de loja fechada, para o tenant suspenso. Devolve true se respondeu.
 *
 * Só vale para o que é da vitrine: caminhos da loja e, com a loja como página
 * inicial, o resto que o visitante alcançaria. O dono que abre /login num
 * tenant suspenso continua vendo o aviso da conta, que é assunto dele.
 */
function responderLojaFechada(manager, req, res, tenant) {
  const p = req.path || '';
  if (p.startsWith('/api/') || p.startsWith('/login')) return false;
  let v = null;
  try { v = lerVitrineDoBanco(manager.getDb(tenant.slug)); } catch { return false; }
  if (!v) return false;
  const daLoja = p === '/loja' || p.startsWith('/loja/') || p.startsWith('/uploads/loja/');
  if (!daLoja && !(Number(v.ativa) === 1 && Number(v.paginaInicial) === 1)) return false;

  const t = v.tema || {};
  const cor = corOk(t.corPrimaria, '#0E6B63');
  const escuro = t.fundo === 'escuro';
  const fundo = escuro ? '#0E1413' : (t.fundo === 'suave' ? '#FBF6F1' : '#F7F8F8');
  const tinta = escuro ? '#E6EDEC' : '#14201F';
  const nome = escHtml(v.nome || 'Loja');
  const zap = whatsappNormalizado(v.whatsapp);
  res.status(503).set('Retry-After', '3600').type('html').send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${corOk(t.corTema, cor)}">
<link rel="icon" href="${v.faviconPath ? escHtml(v.faviconPath) : 'data:,'}">
<title>${nome}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: ${fundo}; color: ${tinta};
    font-family: Inter, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; text-align: center; padding: 24px; }
  img { width: 96px; height: 96px; object-fit: cover; border-radius: 50%; }
  h1 { font-size: 1.6em; margin: 16px 0 8px; }
  p { margin: 0 0 20px; opacity: .8; }
  a { display: inline-block; background: ${cor}; color: #fff; padding: 10px 18px; border-radius: 999px; text-decoration: none; font-weight: 600; }
</style></head><body><main>
  ${v.logoPath ? `<img src="${escHtml(v.logoPath)}" alt="">` : ''}
  <h1>${nome}</h1>
  <p>A loja está fechada no momento.</p>
  ${zap ? `<a href="https://wa.me/${zap}">Falar pelo WhatsApp</a>` : ''}
</main></body></html>`);
  return true;
}

module.exports = {
  migrarLojaDB, registrarRotasLojaPublica, registrarRotasLojaAdmin,
  disponivelDe, rotuloEstoque, TEMA_PADRAO, PRESETS, SUBDIR_LOJA,
  ordemCategorias, compararCategorias,
  marcaVisivel, precoAnterior, personalizacoesDe, validarEscolhas,
  COLUNAS_INFO_LOJA, MODOS_FRETE, lerFoco, usuarioRede, bairrosCobertura, entregaPublica, whatsappNormalizado, lerHorarios, statusAtendimento, empresaDe,
  OPCOES_TEMA, vitrineAntesDoLogin, vitrineNaBarreira, responderLojaFechada, esquecerVitrine,
};
