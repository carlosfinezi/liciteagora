// terramaster-catalog.js
//
// Catálogo TerraMaster com SPECS REAIS (fonte: terramaster.com / terra-master.com,
// coletado 2026-05-30). Usado pelo motor de sugestão de produto (bi-routes
// _sugerirBatch) pra ancorar a compatibilidade em specs verificadas em vez da
// memória do LLM.
//
// IMPORTANTE: a TerraMaster NÃO é comercializada no Brasil — nenhum edital cita
// o modelo. A sugestão é COMPATIBILIDADE/EQUIVALÊNCIA: dado o spec genérico de
// NAS do edital, qual modelo TerraMaster a 1bit ofertaria. Por isso os specs
// (baias, capacidade, RAID, CPU, RAM, rede, formato) é que importam.
//
// Modelos REMOVIDOS do catálogo antigo por NÃO EXISTIREM no site oficial:
//   - F8-424 (8-baias real = F8-422 / F8-SSD)
//   - U12-423 (linha rack só tem U4-423 e U8-423; 12 baias = T12-423 desktop)
//
// Campos "n/d" = não publicado/confirmado na spec page oficial (deixar como
// desconhecido em vez de chutar). Alguns campos das U-722 (Xeon) e F2-223/F2-422
// ficaram a confirmar — ver avisos no fim.

// Tabela compacta pro prompt. Uma linha por modelo:
// MODELO | baias/drives | formato | CPU | RAM base→máx | cap.bruta máx | RAID | rede
const TERRAMASTER_SPECS = `F2-212 | 2 (3.5"/2.5" SATA) | desktop | Realtek RTD1619B ARM 4-core 1.7GHz | 1GB fixa (não expansível) | 44TB | TRAID/0/1/JBOD/Single | 1×1GbE
F2-223 | 2 (SATA) + 2× M.2 NVMe | desktop | Intel Celeron N4505 2-core x86 | 4GB→32GB DDR4 | 40TB | TRAID/0/1/JBOD/Single | 2×2.5GbE
F2-422 | 2 (SATA) | desktop | Intel Celeron J3455 4-core 1.5GHz x86 | 4GB→8GB DDR3L | 36TB | 0/1/JBOD/Single | 1×10GbE + 2×1GbE
F2-424 | 2 (SATA) + 2× M.2 NVMe | desktop | Intel N95 4-core x86 | 8GB→32GB DDR5 | 44TB | TRAID/0/1/JBOD/Single | 2×2.5GbE
F4-212 | 4 (SATA) | desktop | Realtek RTD1619B ARM 4-core 1.7GHz | 2GB fixa (não expansível) | 88TB | TRAID/0/1/5/6/JBOD/Single | 1×1GbE
F4-423 | 4 (SATA) + 2× M.2 NVMe | desktop | Intel Celeron N5095 4-core 2.0GHz x86 | 4GB→32GB DDR4 | 80TB | TRAID/0/1/5/6/10/JBOD/Single | 2×2.5GbE
F4-424 | 4 (SATA) + 2× M.2 NVMe | desktop | Intel N95 4-core x86 | 8GB→32GB DDR5 | 88TB | TRAID/0/1/5/6/10/JBOD/Single | 2×2.5GbE
F4-424 Pro | 4 (SATA) + 2× M.2 NVMe | desktop | Intel Core i3-N305 8-core x86 | 32GB DDR5 | 88TB | TRAID/0/1/5/6/10/JBOD/Single | 2×2.5GbE
F4-424 Max | 4 (SATA) + 2× M.2 NVMe (PCIe4) | desktop | Intel Core i5-1235U 10-core x86 | 8GB→64GB DDR5 | 88TB | TRAID/TRAID+/0/1/5/6/10/JBOD/Single | 2×10GbE
F5-422 | 5 (SATA) | desktop | Intel Celeron J3455 4-core 1.5GHz x86 | 4GB→n/d DDR3L | 100TB | TRAID/0/1/5/6/10/JBOD/Single | 2×1GbE + 1×10GbE
F6-424 Max | 6 (SATA) + 2× M.2 NVMe (PCIe4) | desktop | Intel Core i5-1235U 10-core x86 | 8GB→64GB DDR5 | 132TB | TRAID/TRAID+/0/1/5/6/10/JBOD/Single | 2×10GbE
T9-423 | 9 (SATA) + 1× M.2 NVMe | tower | Intel Celeron N5095 4-core 2.0GHz x86 | 8GB→32GB DDR4 | 180TB | TRAID/0/1/5/6/10/JBOD/Single | 2×2.5GbE
T12-423 | 12 (SATA) + 1× M.2 NVMe | tower | Intel Celeron N5095 4-core 2.0GHz x86 | 8GB→32GB DDR4 | 240TB | TRAID/0/1/5/6/10/JBOD/Single | 2×2.5GbE
T12-500 Pro | 12 (SATA) + 2× M.2 NVMe (PCIe4) | tower | Intel Core i7-1255U 10-core x86 | 16GB→64GB DDR5 | 264TB | TRAID/TRAID+/0/1/5/6/10/JBOD/Single | 2×10GbE; PSU 500W
U4-423 | 4 (SATA) + 1× M.2 NVMe | rack 1U | Intel Celeron N5095 4-core 2.0GHz x86 | 4GB→32GB DDR4 | 80TB | TRAID/0/1/5/6/10/JBOD/Single | 2×2.5GbE; hot-swap; PSU 90W
U8-111 | 8 (SATA) | rack 2U | Intel Celeron J3455 4-core 1.5GHz x86 | 4GB→8GB DDR3L | n/d | TRAID/0/1/5/6/10/JBOD/Single | 1×10GbE
U8-423 | 8 (SATA) + 1× M.2 NVMe | rack 2U | Intel Celeron N5105 4-core 2.0GHz x86 | 4GB→32GB DDR4 | 160TB | TRAID/0/1/5/6/10/JBOD/Single | 2×2.5GbE; PSU 250W (redundante opcional); hot-swap
U16-722-2224 | 16 (SATA) | rack 3U | Intel Xeon E-2224G 4-core 3.5GHz x86 | 8GB→128GB DDR4 | n/d | RAID HW via placa PCIe | 4×1GbE + 2× slot PCIe p/ 10GbE SFP+; PSU 550W
U24-722-2224 | 24 (SATA) | rack 4U (n/d) | Intel Xeon E-2224G 4-core 3.5GHz x86 | 8GB→128GB DDR4 | n/d | n/d (enterprise) | 4×1GbE + PCIe p/ 10GbE SFP+
D2-310 | 2 (SATA) | DAS desktop (SEM CPU/RAM/rede) | — | — | 40TB | 0/1/JBOD/Single (switch manual) | conexão USB-C 3.1 Gen1 (5Gbps)
D4-300 | 4 (SATA) | DAS desktop (SEM CPU/RAM/rede) | — | — | 80TB | Single/JBOD (sem RAID HW) | conexão USB-C 3.1 Gen1 (5Gbps)
D5 Hybrid | 5 = 2× SATA + 3× M.2 NVMe | DAS desktop (SEM CPU/RAM/rede) | — | — | 88TB | 0/1/JBOD/Single (só nas 2 SATA) | conexão USB-C 3.2 Gen2 (10Gbps)
D8 Hybrid | 8 = 4× SATA + 4× M.2 NVMe | DAS desktop (SEM CPU/RAM/rede) | — | — | 160TB | 0/1/JBOD/Single (slots 1-2) | conexão USB-C 3.2 Gen2 (10Gbps)
D16 Thunderbolt | 16 (SATA) | DAS tower (SEM CPU/RAM/rede) | — | — | 288TB | 0/1/5/6/10/50/JBOD/Single (RAID por hardware) | conexão Thunderbolt 3 (40Gbps); NÃO USB`;

// Conjunto de códigos VÁLIDOS (normalizado lowercase, sem espaços extras) pra
// validação server-side da resposta do LLM. Qualquer modelo_sugerido fora deste
// conjunto (e diferente de "nenhum") é tratado como inválido.
const TERRAMASTER_MODELOS = new Set([
  'f2-212', 'f2-223', 'f2-422', 'f2-424',
  'f4-212', 'f4-423', 'f4-424', 'f4-424 pro', 'f4-424 max',
  'f5-422', 'f6-424 max',
  't9-423', 't12-423', 't12-500 pro',
  'u4-423', 'u8-111', 'u8-423', 'u16-722-2224', 'u24-722-2224',
  'd2-310', 'd4-300', 'd5 hybrid', 'd8 hybrid', 'd16 thunderbolt',
]);

// Normaliza um código pra comparação (lowercase, colapsa espaços, trim).
function normalizarModelo(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// true se o código está num conjunto de modelos válidos (ou é o sentinela
// "nenhum"). Sem conjunto cadastrado → não dá pra validar, aceita.
function modeloValidoEm(s, modelosSet) {
  const n = normalizarModelo(s);
  if (n === 'nenhum' || n === '') return true;
  if (!modelosSet || modelosSet.size === 0) return true;
  return modelosSet.has(n);
}

// Normaliza a config de catálogo vinda do banco (bi_sugestao_catalogo) num
// objeto estável: { marca, categoria, regras, specs, modelos:Set|null }.
function normalizarCatalogo(cfg, marcaFallback) {
  cfg = cfg || {};
  const marca = String(cfg.marca || marcaFallback || '').trim();
  let modelos = null;
  if (cfg.modelos) {
    const arr = Array.isArray(cfg.modelos) ? cfg.modelos : String(cfg.modelos).split(/[\n,;]+/);
    const norm = arr.map(normalizarModelo).filter(Boolean);
    if (norm.length) modelos = new Set(norm);
  }
  return {
    marca,
    categoria: (cfg.categoria && String(cfg.categoria).trim()) || null,
    regras: (cfg.regras && String(cfg.regras).trim()) || null,
    specs: (cfg.specs && String(cfg.specs).trim()) || null,
    modelos,
  };
}

// Monta o prompt de sugestão (equivalência técnica) pra um batch de itens, 100%
// dirigido pela config da marca (tabela bi_sugestao_catalogo). Fonte única usada
// pelo endpoint (bi-routes _sugerirBatch) e pelo script de regeneração.
function montarPromptSugestao(itens, cfg) {
  const c = normalizarCatalogo(cfg);
  const marca = c.marca;
  const categoria = c.categoria ? ` (${c.categoria})` : '';

  const linhas = itens.map((it, idx) => {
    const desc = String(it.descricao || '').replace(/\s+/g, ' ').substring(0, 600);
    return `[${idx + 1}] ${desc}`;
  }).join('\n');

  const catalogoBloco = c.specs
    ? `CATÁLOGO ${marca.toUpperCase()} — SPECS (use EXCLUSIVAMENTE estes modelos; "n/d" = não confirmado):
${c.specs}`
    : `CATÁLOGO ${marca.toUpperCase()}: (sem tabela de specs cadastrada — use só modelos que você tem CERTEZA absoluta que existem; na dúvida, modelo_sugerido="nenhum")`;

  const regrasBloco = c.regras ? `\nREGRAS DA MARCA:\n${c.regras}\n` : '';
  const regraCodigos = c.modelos
    ? 'NUNCA invente códigos. Use EXCLUSIVAMENTE os modelos do catálogo acima — qualquer código fora dele será DESCARTADO pelo sistema.'
    : 'NUNCA invente códigos: só use modelos que você tem CERTEZA que existem; na dúvida, modelo_sugerido="nenhum".';

  return `Você é especialista em ${marca}${categoria} e analisa especificações de licitações públicas BRASILEIRAS pra recomendar o modelo ${marca} mais COMPATÍVEL. A marca NÃO é citada no edital — é equivalência técnica: ache o modelo cujos specs atendem o pedido.

${catalogoBloco}
${regrasBloco}
${regraCodigos}

PEDIDOS DE COMPRA (formato [#] descrição/especificação):
${linhas}

Pra CADA pedido: extraia os requisitos-chave e escolha o modelo cujos specs ATENDEM ou superam o pedido. Requisitos quantitativos (capacidade, nº de itens, tamanho, formato) são DUROS: NÃO sugira modelo abaixo do pedido. Se o pedido não for compatível com a marca, modelo_sugerido="nenhum", score=0.

Retorne JSON conciso (sem markdown, sem texto fora do JSON):
{
  "sugestoes": [
    { "indice": 1, "requisitos": "resumo dos requisitos", "modelo_sugerido": "CÓDIGO ou nenhum", "score": 90, "motivo": "por que atende" }
  ]
}

Score (0-100): 90-100 encaixe ideal; 70-89 atende com folga/pequena diferença; 50-69 aceitável forçado; 0 sem match/fora do catálogo.
TODOS os itens DEVEM aparecer na resposta com o respectivo índice.`;
}

// Validação server-side anti-alucinação: se a marca tem lista de modelos
// cadastrada, código fora dela vira "nenhum". Sem lista, passa sem validar.
// Muta e retorna o array.
function validarSugestoes(sugestoes, cfg) {
  if (!Array.isArray(sugestoes)) return sugestoes;
  const c = normalizarCatalogo(cfg);
  if (!c.modelos) return sugestoes;
  for (const s of sugestoes) {
    if (s && s.modelo_sugerido && !modeloValidoEm(s.modelo_sugerido, c.modelos)) {
      const orig = String(s.modelo_sugerido);
      s.modelo_sugerido = 'nenhum';
      s.score = 0;
      s.motivo = `[código fora do catálogo cadastrado: ${orig} — descartado] ${String(s.motivo || '')}`.substring(0, 400);
    }
  }
  return sugestoes;
}

// ── Seed do tenant 1bit (marca TerraMaster) ────────────────────────────────
// Popula bi_sugestao_catalogo sem mudar o comportamento da 1bit (specs/regras/
// modelos reais embutidos abaixo). As regras saíram do prompt antigo (NAS/DAS).
const TERRAMASTER_CATEGORIA = 'gabinetes/sistemas NAS e DAS';
const TERRAMASTER_REGRAS = `TerraMaster fabrica APENAS gabinetes/sistemas NAS e DAS. NÃO fabrica HDDs/SSDs avulsos, switches, cabos, software, racks vazios, fontes ou outros acessórios. Se o pedido for por:
- HD/HDD/SSD avulso (mesmo "para NAS", ex: WD Red, Seagate IronWolf) → modelo_sugerido="nenhum", score=0
- Switch, roteador, cabo de rede → modelo_sugerido="nenhum", score=0
- Software, licença, sistema operacional → modelo_sugerido="nenhum", score=0
- Servidor de rack genérico sem características de NAS → modelo_sugerido="nenhum", score=0
DAS (série D) não têm CPU/RAM/rede: só sugira DAS se o pedido for expansão de discos sem sistema/rede.
Quando a especificação é genérica ("STORAGE NAS" sem detalhes técnicos): escolha um desktop popular compatível (F4-423 ou F4-424), score 70.`;

const TERRAMASTER_SEED = {
  marca: 'TerraMaster',
  categoria: TERRAMASTER_CATEGORIA,
  regras: TERRAMASTER_REGRAS,
  specs: TERRAMASTER_SPECS,
  modelos: Array.from(TERRAMASTER_MODELOS),
};

module.exports = {
  TERRAMASTER_SPECS, TERRAMASTER_MODELOS, TERRAMASTER_SEED,
  normalizarModelo, modeloValidoEm, normalizarCatalogo,
  montarPromptSugestao, validarSugestoes,
};
