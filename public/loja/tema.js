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
  const v = {
    '--primaria': t.corPrimaria,
    '--primaria-texto': textoSobre(t.corPrimaria),
    '--ground':  escuro ? '#0E1413' : '#F7F8F8',
    '--surface': escuro ? '#171F1E' : '#FFFFFF',
    '--ink':     escuro ? '#E6EDEC' : '#14201F',
    '--ink-2':   escuro ? '#9DADAB' : '#5A6A68',
    '--line':    escuro ? '#2A3634' : '#E1E7E6',
    '--raio':    (Number(t.raio) || 0) + 'px',
    '--fonte':   FONTES[t.fonte] || FONTES.neutra,
  };
  for (const [k, val] of Object.entries(v)) document.documentElement.style.setProperty(k, val);
  document.documentElement.style.colorScheme = escuro ? 'dark' : 'light';
}

const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ROTULO = { disponivel: 'Disponível', ultimas: 'Últimas unidades', 'sob-consulta': 'Sob consulta' };

function linkZap(texto) {
  if (!LOJA?.whatsapp) return null;
  return 'https://wa.me/' + LOJA.whatsapp + '?text=' + encodeURIComponent(texto);
}
