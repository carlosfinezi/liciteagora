// marca-extractor.js — Onda 3 (2026-05-06)
//
// Heurística para extrair marca/fabricante do texto livre da descrição
// dos itens (campo `itens.descricao`). O PNCP/Dados Abertos NÃO devolvem
// marca como campo estruturado — fica embutida no texto, com qualidade
// muito variável por órgão.
//
// Saída: { marca: 'Dell' | null, confianca: 0..1, fonte: 'rotulo'|'catalogo'|null }
//
// Estratégia em 3 passes (do mais confiável pro menos):
//  1. ROTULO        — busca padrões "Marca/Fabricante:", "MARCA: X", etc.
//                     Captura o token após o rótulo. Confiança 0.95.
//  2. REFERENCIA    — busca "MARCA DE REFERENCIA: X, Y, Z" — pega o primeiro.
//                     Confiança 0.85. (É a marca *citada como benchmark*,
//                     não necessariamente a entregue.)
//  3. CATALOGO      — varre a descrição procurando marcas conhecidas como
//                     palavras inteiras. Confiança 0.6 (1 match) / 0.75 (2+).
//
// Lista CATALOGO_MARCAS é expansível e cobre ~250 marcas brasileiras/globais
// comuns em licitações públicas (TI, escritório, automotivo, médico, limpeza,
// alimentos, ferramentas, indústria).

'use strict';

// Marcas conhecidas (case-insensitive na busca). Mantém a forma canônica
// aqui — match retorna esta string com a capitalização correta.
//
// Ordem por categoria; dentro da categoria por relevância no setor público.
const CATALOGO_MARCAS = [
  // TI — Computadores
  'Dell', 'HP', 'Lenovo', 'Acer', 'Apple', 'Samsung', 'Asus', 'LG',
  'Positivo', 'Multilaser', 'Daten', 'Itautec', 'CCE', 'Microsoft',
  // TI — Periféricos / Impressão
  'Brother', 'Epson', 'Canon', 'Xerox', 'Ricoh', 'Kyocera', 'Lexmark',
  'OKI', 'Pantum', 'Logitech', 'Microsoft', 'Razer', 'Genius',
  // TI — Componentes
  'Intel', 'AMD', 'NVIDIA', 'Kingston', 'Crucial', 'Corsair', 'Goldentec',
  'Western Digital', 'WD', 'Seagate', 'Sandisk', 'Toshiba',
  // Networking
  'Cisco', 'Intelbras', 'D-Link', 'TP-Link', 'Mikrotik', 'Ubiquiti',
  'Aruba', 'Huawei', 'Juniper', 'Furukawa',
  // UPS / Energia
  'APC', 'SMS', 'Ragtech', 'NHS', 'TS Shara', 'Eaton', 'Schneider',
  // Audio/video
  'Sony', 'JBL', 'Philco', 'Bose', 'Yamaha', 'Pioneer', 'Roland',
  // Telefonia
  'Motorola', 'Xiaomi', 'Nokia', 'Asus', 'Realme',
  // Escritório / Papelaria
  'Faber Castell', 'Faber-Castell', 'Bic', 'Tilibra', 'Mercur', 'Pilot',
  'Stabilo', 'Pentel', 'Maped', 'Cis', 'Jocar', 'Ecolapis', 'Acrilex',
  '3M', 'Pritt', 'Plimpa', 'Foroni', 'Dohler', 'Norpac',
  // Automotivo - Caminhões/Carros
  'Ford', 'Volkswagen', 'VW', 'Toyota', 'Mercedes-Benz', 'Mercedes',
  'Iveco', 'Volvo', 'Scania', 'Fiat', 'Chevrolet', 'GM', 'Hyundai',
  'Renault', 'Peugeot', 'Citroen', 'Honda', 'Nissan', 'Kia', 'Mitsubishi',
  'Yamaha', 'BMW', 'Audi', 'Suzuki',
  // Automotivo - Peças
  'Bosch', 'Cofap', 'Magneti Marelli', 'Bardahl', 'Castrol', 'Lubrax',
  'Petronas', 'Mobil', 'Shell', 'Texaco', 'Ipiranga', 'Goodyear',
  'Pirelli', 'Michelin', 'Bridgestone', 'Firestone',
  // Ferramentas / Construção
  'Tramontina', 'Vonder', 'Mor', 'Stanley', 'DeWalt', 'Makita',
  'Black & Decker', 'Black+Decker', 'Bosch', 'Milwaukee', 'Hilti',
  'Belgo', 'Gerdau', 'Tigre', 'Amanco', 'Krona', 'Astra', 'Deca',
  // Eletrodomésticos
  // (removido 'Continental' — colide com "continente"; deixado nos pneus)
  'Brastemp', 'Consul', 'Electrolux', 'Whirlpool', 'Mondial', 'Britânia',
  'Philco', 'Esmaltec', 'Cônsul', 'Arno', 'Black+Decker',
  // Limpeza
  // (removido 'Brilhante', 'Worker', 'Cif' — colidem com palavras comuns)
  'Bombril', 'Veja', 'Ypê', 'Ype', 'Limpol', 'OMO',
  'Tixan', 'Ariel', 'Vanish', 'Pinho Sol', 'Lysoform',
  'Kalyptus', 'Nazca',
  // Higiene
  // (removido 'Personal', 'Dove', 'Lux' — palavras genéricas)
  'Johnson', 'Johnson & Johnson', 'Colgate', 'Sorriso', 'Oral-B', 'Pampers',
  'Huggies', 'BIC', 'Gillette', 'Prestobarba',
  'Palmolive', 'Protex', 'Nivea',
  // Alimentos / Cozinha
  'Nestlé', 'Sadia', 'Perdigão', 'Seara', 'Aurora', 'Friboi', 'Marfrig',
  'JBS', 'Camil', 'Oderich', 'Bela Vista', 'Kraft', 'Coca-Cola',
  'Pepsi', 'Ambev', 'Heinz', 'Hellmann\'s',
  // Bebidas
  'Coca-Cola', 'Pepsi', 'Guaraná Antarctica', 'Schweppes', 'Del Valle',
  'Tang', 'Suco Mais',
  // Médico / Hospitalar
  'BD', 'Becton Dickinson', 'Cremer', 'Nipro', 'Hartmann', 'Polar Fix',
  'Descarpack', 'Solidor', 'Embramac', 'Surgicos', 'Medix', 'Bioland',
  'Welch Allyn', 'Medline', 'Smith Nephew', 'Smiths Medical',
  // Farmacêutica
  'EMS', 'Eurofarma', 'Aché', 'Ache', 'Sanofi', 'GSK', 'Pfizer',
  'Roche', 'Bayer', 'Novartis', 'Medley', 'Neo Química', 'Neoquimica',
  'Cimed', 'Hypera', 'Biolab', 'Sandoz', 'Teuto',
  // Lab / Reagentes
  // (removido 'Neon' — colide com cor/estilo neon em papelaria)
  'Sigma-Aldrich', 'Sigma Aldrich', 'Merck', 'Vetec', 'Synth',
  'LabSynth', 'Dinâmica', 'Dinamica',
  // EPI / Segurança
  'Vonder', '3M', 'Carbografite', 'Plastcor', 'Volk', 'Marluvas',
  'Bracol', 'Promat', 'Steel Pro', 'Camper', 'Bota Brasil',
  // Esporte / Material esportivo
  'Penalty', 'Topper', 'Dalponte', 'Vollo', 'Mikasa', 'Wilson',
  'Olympikus', 'Mizuno', 'Asics', 'Nike', 'Adidas', 'Puma',
];

// Pré-computa regex de catálogo: uma alternação grande, case-insensitive.
// Escapa caracteres especiais e exige limite de palavra para evitar
// false positive (ex: "Faberge" não bate "Faber Castell").
function _escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Mapa lowercase → forma canônica para retorno bonitinho
const _MARCA_MAP = new Map();
CATALOGO_MARCAS.forEach(m => _MARCA_MAP.set(m.toLowerCase(), m));
const _MARCAS_ORDENADAS = [...new Set(CATALOGO_MARCAS)]
  .sort((a, b) => b.length - a.length); // mais longas primeiro (Faber Castell antes de Faber)
const _CATALOGO_REGEX = new RegExp(
  `(?<![\\w-])(${_MARCAS_ORDENADAS.map(_escapeRegex).join('|')})(?![\\w-])`,
  'gi'
);

// Padrões de rótulo explícito (alta confiança)
//
// Captura o token após "marca:", "fabricante:", "marca/fabricante:".
// Para após linebreak, ponto-e-vírgula, ou ~50 chars (para não pegar
// parágrafo inteiro quando a descrição esquece a pontuação).
const _ROTULO_REGEX = /\b(?:marca\s*[\/]?\s*fabricante|marca|fabricante)\s*[:\-]\s*([^\n;]{1,60})/i;

// Padrão "MARCA DE REFERENCIA: X, Y, Z" — pega o primeiro nome
const _REFERENCIA_REGEX = /\bmarca(?:s)?\s+de\s+refer[êe]ncia\s*[:\-]\s*([^\n;]{1,80})/i;

// Stop-words que aparecem após rótulo mas não são marca real
const _STOP_TOKENS = new Set([
  'a', 'do', 'da', 'de', 'no', 'na', 'em', 'com', 'sem',
  'referencia', 'referência', 'preferencial', 'sugerida', 'sugestão', 'sugestao',
  'qualquer', 'similar', 'equivalente', 'igual', 'superior',
  'propria', 'própria', 'a definir', 'definir', 'a-definir',
  'n/a', 'na', 'na.', 'na;', 'nd', 'n.d.', 'nao', 'não',
  'consta', 'informar', 'informada', 'informado',
  'a informar', '-', '--', '...', 'xxx', 'xxxxx',
]);

function _normalizarToken(raw) {
  let s = String(raw || '').trim();
  // Remove sufixos comuns: " ou similar", " ou equivalente", " (qualquer)"
  s = s.replace(/\s*(?:ou\s+(?:similar|equivalente|melhor|superior).*$|\(.*?\)\s*$)/i, '');
  // Pega só o primeiro nome se houver vírgula/barra (lista de referência)
  s = s.split(/[,/]/)[0].trim();
  // Remove pontuação ao redor
  s = s.replace(/^[\s\-.;:]+|[\s\-.;:]+$/g, '');
  return s;
}

function _ehStopWord(token) {
  const lower = token.toLowerCase().trim();
  if (lower.length < 2) return true;
  if (_STOP_TOKENS.has(lower)) return true;
  // Token só com pontuação ou números
  if (!/[a-zA-ZÀ-ÿ]/.test(lower)) return true;
  return false;
}

// Bate o token extraído contra o catálogo para retornar a forma canônica.
// Se não bater no catálogo, devolve o próprio token (capitalizado básico)
// — usuário ainda vê a marca declarada pelo edital, mesmo que rara.
function _canonicalizar(token) {
  const lower = token.toLowerCase();
  if (_MARCA_MAP.has(lower)) return _MARCA_MAP.get(lower);
  // Tenta também a primeira palavra (ex: "Faber Castell preto" → "Faber Castell")
  for (const m of _MARCAS_ORDENADAS) {
    if (lower.startsWith(m.toLowerCase() + ' ') || lower === m.toLowerCase()) {
      return m;
    }
  }
  // Capitaliza o primeiro caractere de cada palavra do que veio
  return token
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3) // no máximo 3 palavras (ex: "Faber Castell Pro")
    .map(w => w.length <= 3 ? w.toUpperCase() : (w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

/**
 * Extrai marca/fabricante de uma descrição livre.
 * @param {string} descricao
 * @returns {{ marca: string|null, confianca: number, fonte: string|null }}
 */
function extrairMarca(descricao) {
  if (!descricao || typeof descricao !== 'string') {
    return { marca: null, confianca: 0, fonte: null };
  }
  const txt = descricao.replace(/\r/g, ' ').slice(0, 4000); // bound

  // 1) Rótulo explícito
  const mRotulo = _ROTULO_REGEX.exec(txt);
  if (mRotulo) {
    const tok = _normalizarToken(mRotulo[1]);
    if (tok && !_ehStopWord(tok)) {
      return { marca: _canonicalizar(tok), confianca: 0.95, fonte: 'rotulo' };
    }
  }

  // 2) Marca de referência (lista de benchmark)
  const mRef = _REFERENCIA_REGEX.exec(txt);
  if (mRef) {
    const tok = _normalizarToken(mRef[1]);
    if (tok && !_ehStopWord(tok)) {
      return { marca: _canonicalizar(tok), confianca: 0.85, fonte: 'referencia' };
    }
  }

  // 3) Match no catálogo de marcas conhecidas
  _CATALOGO_REGEX.lastIndex = 0;
  const matches = [];
  let m;
  while ((m = _CATALOGO_REGEX.exec(txt)) !== null) {
    const canon = _MARCA_MAP.get(m[1].toLowerCase());
    if (canon && !matches.includes(canon)) matches.push(canon);
    if (matches.length >= 5) break;
  }
  if (matches.length === 1) {
    return { marca: matches[0], confianca: 0.6, fonte: 'catalogo' };
  }
  if (matches.length >= 2) {
    // Múltiplas marcas: pega a primeira mas indica menor confiança porque
    // pode ser lista de "ou similares".
    return { marca: matches[0], confianca: 0.5, fonte: 'catalogo' };
  }

  return { marca: null, confianca: 0, fonte: null };
}

module.exports = {
  extrairMarca,
  CATALOGO_MARCAS,
};
