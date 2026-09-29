/**
 * tema.js — tokens visuais do catálogo público.
 *
 * Extraído do inline da página na Fase 50, sem mudança de comportamento: é o
 * mesmo aplicarTema() que já vestia a loja com a cor, a fonte e o raio
 * escolhidos pelo lojista. Num arquivo próprio, ele passa a ser parseado pelo
 * `npm run verify` — o inline das páginas públicas é pulado de propósito.
 *
 * Aqui também moram os utilitários que as duas telas compartilham (brl, esc,
 * linkZap). Eles já existiam; só mudaram de lugar.
 */
/**
 * Famílias do catálogo público.
 *
 * As três foram modernizadas na Fase 51. A `editorial` era Georgia — serif de
 * 1993 — e era ela que dava ao catálogo a "aparência antiga" relatada; note que
 * isso NÃO era descuido do código: é a opção que o lojista escolheu em
 * Aparência. Trocar a família mantém a escolha dele de ter um estilo próprio,
 * sem manter a aparência datada.
 *
 * `Inter` é a fonte que o ERP inteiro já usa (`public/css/app-modern.css`), e
 * por isso não há import novo — a folha do Google Fonts que a página carrega é
 * a mesma família que o painel administrativo carrega há meses.
 */
const SISTEMA = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';
const FONTES = {
  neutra:    `Inter, ${SISTEMA}`,
  tecnica:   `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
  /* "Expressiva": continua sendo a opção COM PERSONALIDADE, que é o que o
     lojista escolhe ao fugir da neutra — só deixou de ser uma serif de 1993.
     Poppins é geométrica e moderna, e mantém as três opções distintas entre si.
     Fazer `editorial` virar Inter teria deixado duas opções idênticas, o que é
     pior que a serif: uma escolha que não muda nada. */
  editorial: `Poppins, Inter, ${SISTEMA}`,
  // Arredondada e calorosa: pensada para floricultura, confeitaria, presente.
  amigavel:  `Nunito, Inter, ${SISTEMA}`,
};

/* Fonte só dos títulos (nome da loja, seções, produto). 'igual' usa a do
   texto. As decorativas ficam nos títulos de propósito: manuscrita num
   parágrafo de preço vira ilegível. */
const FONTES_TITULO = {
  elegante:   `"Playfair Display", Georgia, serif`,
  classica:   `"Cormorant Garamond", Georgia, serif`,
  // Serifa do sistema: não baixa nada, e é a do protótipo do Cantinho Verde.
  serifa:     `Georgia, "Times New Roman", serif`,
  manuscrita: `"Dancing Script", cursive`,
  moderna:    `Poppins, Inter, ${SISTEMA}`,
};

/* A página carrega Inter e Poppins de saída. As outras famílias só descem
   quando o lojista as escolhe: baixar seis fontes para usar duas deixaria a
   vitrine lenta no 4G de quem compra pelo celular. */
const GOOGLE_FONTS = {
  tecnica: 'JetBrains+Mono:wght@400;600',
  amigavel: 'Nunito:wght@400;600;700;800',
  elegante: 'Playfair+Display:wght@500;700',
  classica: 'Cormorant+Garamond:wght@500;700',
  manuscrita: 'Dancing+Script:wght@600;700',
};
function carregarFonte(chave) {
  const familia = GOOGLE_FONTS[chave];
  if (!familia || document.querySelector(`link[data-fonte="${chave}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = `https://fonts.googleapis.com/css2?family=${familia}&display=swap`;
  l.dataset.fonte = chave;
  document.head.appendChild(l);
}

const FUNDOS = {
  claro:  { ground: '#F7F8F8', surface: '#FFFFFF', ink: '#14201F', ink2: '#5A6A68', line: '#E1E7E6' },
  // Creme quente, para vitrine de flor, doce e presente.
  suave:  { ground: '#FBF6F1', surface: '#FFFFFF', ink: '#2B201C', ink2: '#76655E', line: '#EEE2D8' },
  escuro: { ground: '#0E1413', surface: '#171F1E', ink: '#E6EDEC', ink2: '#9DADAB', line: '#2A3634' },
};

// Contraste do texto sobre a cor escolhida pelo lojista. Sem isto, uma cor
// clara vira botão de texto branco ilegível.
function textoSobre(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.42 ? '#11201F' : '#FFFFFF';
}

function aplicarTema(t) {
  const escuro = t.fundo === 'escuro';
  const f = FUNDOS[t.fundo] || FUNDOS.claro;
  const secundaria = t.corSecundaria || t.corPrimaria;
  const fonte = FONTES[t.fonte] || FONTES.neutra;
  const v = {
    '--primaria': t.corPrimaria,
    '--primaria-texto': textoSobre(t.corPrimaria),
    '--secundaria': secundaria,
    '--secundaria-texto': textoSobre(secundaria),
    '--ground':  t.corFundo || f.ground,
    '--apoio':   t.corApoio || secundaria,
    '--surface': f.surface,
    '--ink':     f.ink,
    '--ink-2':   f.ink2,
    '--line':    f.line,
    '--raio':    (Number(t.raio) || 0) + 'px',
    '--fonte':   fonte,
    '--fonte-titulo': FONTES_TITULO[t.fonteTitulo] || fonte,
  };
  for (const [k, val] of Object.entries(v)) document.documentElement.style.setProperty(k, val);
  document.documentElement.style.colorScheme = escuro ? 'dark' : 'light';
  // Acabamento: a folha da página lê estes marcadores (ver index.html).
  const html = document.documentElement;
  html.dataset.fundoEfeito = t.fundoEfeito || 'liso';
  html.dataset.sombra = t.sombra || 'nenhuma';
  html.dataset.topo = t.topo || 'solido';
  carregarFonte(t.fonte);
  carregarFonte(t.fonteTitulo);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.corTema || t.corPrimaria);
}

/** Ícone da aba enviado pelo lojista. Sem ele fica o ícone vazio da página. */
function aplicarFavicon(href) {
  if (!href) return;
  let l = document.querySelector('link[rel="icon"]');
  if (!l) { l = document.createElement('link'); l.rel = 'icon'; document.head.appendChild(l); }
  /* Com ícone, a loja declara também a aba em 16 e 32 px, o atalho do celular
     e o próprio manifest (29/09). Tudo sai de /loja/icones/, que cai no ícone
     enviado quando falta a versão daquele tamanho. */
  const link = (rel, url, tam) => {
    const e = document.createElement('link');
    e.rel = rel; e.href = url; if (tam) e.sizes = tam;
    document.head.appendChild(e);
  };
  l.href = '/loja/icones/32.png'; l.type = 'image/png'; l.sizes = '32x32';
  link('icon', '/loja/icones/16.png', '16x16');
  link('apple-touch-icon', '/loja/icones/180.png');
  link('manifest', '/loja/manifest.webmanifest');
}

const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ROTULO = { disponivel: 'Disponível', ultimas: 'Últimas unidades', 'sob-consulta': 'Sob consulta' };

function linkZap(texto) {
  if (!LOJA?.whatsapp) return null;
  return 'https://wa.me/' + LOJA.whatsapp + '?text=' + encodeURIComponent(texto);
}
