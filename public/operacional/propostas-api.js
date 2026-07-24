/**
 * propostas-api.js — Envio de propostas via API Comprasnet (sem extensão no browser)
 *
 * Fluxo:
 * 1. Carrega participações do banco (sincronizadas pela extensão)
 * 2. Para cada uma, busca itens via API do servidor
 * 3. Usuário configura valores
 * 4. Envia proposta via POST /api/proposta/enviar-api (server → Comprasnet API)
 */

let participacoesData = [];
let allParticipacoes = []; // participações cruas do Comprasnet (/api/proposta/participacoes)
let interessesData = []; // licitações de interesse (vindas do PNCP)
let interessesVisiveis = true;
let disputasData = new Map(); // compraId → { itens, orgao, objeto, ... }
let valoresLocais = {}; // compraId:itemNumero → { valor, marca, modelo, fabricante, selecionado }
let fornecedorConfig = null; // dados do fornecedor (declarações, etc.)

// ==================== STORAGE LOCAL ====================

function salvarValoresLocal() {
    try {
        localStorage.setItem('propostas-api-valores', JSON.stringify(valoresLocais));
    } catch (e) {}
}

function carregarValoresLocal() {
    try {
        const saved = localStorage.getItem('propostas-api-valores');
        if (saved) valoresLocais = JSON.parse(saved);
    } catch (e) {}
}

function keyItem(compraId, numero) {
    return `${compraId}:${numero}`;
}

function getValorItem(compraId, numero) {
    return valoresLocais[keyItem(compraId, numero)] || {
        valor: null, marca: '', modelo: '', fabricante: '', selecionado: false
    };
}

function setValorItem(compraId, numero, dados) {
    valoresLocais[keyItem(compraId, numero)] = {
        ...getValorItem(compraId, numero),
        ...dados
    };
    salvarValoresLocal();
}

// Resolve cnpj/ano/sequencial a partir de um compraId real ou prefixo "interesse-CNPJ-ANO-SEQ"
function resolveIdsLicitacao(compraIdOrPrefix) {
    for (const lic of interessesData) {
        if (lic.compraId && lic.compraId === compraIdOrPrefix) {
            return { cnpj: lic.cnpj, ano: lic.ano, sequencial: lic.sequencial };
        }
        if (`interesse-${lic.cnpj}-${lic.ano}-${lic.sequencial}` === compraIdOrPrefix) {
            return { cnpj: lic.cnpj, ano: lic.ano, sequencial: lic.sequencial };
        }
    }
    return null;
}

// Persiste valor/marca/modelo/selecionado no banco (debounced por item)
const _persistTimers = {};
function persistirItemBanco(compraIdOrPrefix, numero) {
    const ids = resolveIdsLicitacao(compraIdOrPrefix);
    if (!ids) return;
    const key = keyItem(compraIdOrPrefix, numero);
    clearTimeout(_persistTimers[key]);
    _persistTimers[key] = setTimeout(() => {
        const d = getValorItem(compraIdOrPrefix, numero);
        fetch('/api/valores-proposta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cnpj: ids.cnpj, ano: ids.ano, sequencial: ids.sequencial,
                numeroItem: numero,
                valorUnitario: d.valor,
                marca: d.marca || '',
                modelo: d.modelo || '',
                fabricante: d.fabricante || '',
                selecionado: !!d.selecionado,
            }),
        }).catch(() => {});
    }, 400);
}

// Rehidrata valoresLocais a partir do banco (chamado antes de renderizar)
async function carregarValoresDoBanco() {
    try {
        const resp = await fetch('/api/valores-proposta');
        const data = await resp.json();
        if (!data.success || !Array.isArray(data.valores)) return;
        const mapa = new Map();
        for (const v of data.valores) {
            mapa.set(`${v.cnpj}|${v.ano}|${v.sequencial}|${v.numeroItem}`, v);
        }
        for (const lic of interessesData) {
            const prefix = lic.compraId || `interesse-${lic.cnpj}-${lic.ano}-${lic.sequencial}`;
            const itens = lic.itens || [];
            for (const item of itens) {
                const hit = mapa.get(`${lic.cnpj}|${lic.ano}|${lic.sequencial}|${item.numero}`);
                if (!hit) continue;
                const k = keyItem(prefix, item.numero);
                valoresLocais[k] = {
                    ...(valoresLocais[k] || {}),
                    valor: hit.valorUnitario,
                    marca: hit.marca || '',
                    modelo: hit.modelo || '',
                    fabricante: hit.fabricante || '',
                    selecionado: hit.selecionado === 1,
                };
            }
        }
        salvarValoresLocal();
    } catch (e) {}
}

// ==================== TOKEN STATUS ====================

async function atualizarTokenStatus() {
    const div = document.getElementById('tokenStatus');
    try {
        const resp = await fetch('/api/sniper/status');
        const result = await resp.json();
        const s = result.status || result;

        if (s.temToken && !s.tokenExpirado) {
            div.innerHTML = `<span class="token-ok">Token ativo (${s.tokenIdade})</span>`;
            div.className = 'token-status ok';
        } else if (s.temToken && s.tokenExpirado) {
            div.innerHTML = `<span class="token-warn">Token expirado (${s.tokenIdade})</span>`;
            div.className = 'token-status warn';
        } else {
            div.innerHTML = `<span class="token-err">Não conectado ao Electron Browser</span>`;
            div.className = 'token-status err';
        }
    } catch (e) {
        div.innerHTML = `<span class="token-err">Erro ao verificar token</span>`;
        div.className = 'token-status err';
    }
}

// ==================== CARREGAR DADOS ====================

function construirParticipacoes(allParticipacoes) {
    participacoesData = [];
    const compraIdSet = new Set();
    // BNC/BLL/PCP têm tela própria (módulo Portais) — não entram nesta página.
    interessesData.filter(lic => !ehPortalProprio(lic)).forEach(lic => {
        const cid = lic.compraId || `interesse-${lic.cnpj}-${lic.ano}-${lic.sequencial}`;
        if (compraIdSet.has(cid)) return;
        compraIdSet.add(cid);

        const part = lic.compraId ? allParticipacoes.find(p => p.compraId === lic.compraId) : null;
        const naoComprasnet = lic.compraId?.startsWith('NAO_COMPRASNET:');
        const sistemaOrigem = naoComprasnet ? lic.compraId.replace('NAO_COMPRASNET:', '') : null;

        participacoesData.push({
            compraId: cid,
            objeto: lic.objetoCompra || part?.objeto || 'Objeto não disponível',
            orgao: lic.nomeOrgao || part?.orgao || '',
            situacao: part?.situacao || lic.situacaoParticipacao || '',
            faseCompra: part?.faseCompra || lic.faseCompraParticipacao || '',
            etapa: part?.etapa || '',
            dataSessao: lic.dataEncerramentoProposta || part?.dataSessao || '',
            grupoNome: lic.grupoNome || '',
            semCompraId: !lic.compraId || naoComprasnet,
            naoComprasnet,
            sistemaOrigem,
            // estadoTrabalho: prioriza o calculado pelo backend (cruzando com participacoes_comprasnet),
            // cai para o estado da participação direta, e por último 'a-enviar' como fallback seguro.
            estadoTrabalho: lic.estadoTrabalho || part?.estadoTrabalho || 'a-enviar',
            propostaEnviadaEm: lic.propostaEnviadaEm || part?.propostaEnviadaEm || null,
        });

        if (lic.itens?.length > 0 && !disputasData.has(cid)) {
            disputasData.set(cid, {
                compraId: cid,
                itens: lic.itens.map(it => ({
                    numero: it.numero,
                    descricao: it.descricao,
                    quantidade: it.quantidade || 1,
                    unidadeMedida: it.unidadeMedida,
                    valorEstimado: it.valorEstimado,
                    melhorValor: null,
                    nossoValor: null,
                    situacaoParticipante: null,
                })),
                orgao: lic.nomeOrgao,
                objeto: lic.objetoCompra,
                fonte: 'interesse',
            });
        }
    });
}

function atualizarStats() {
    // BNC/BLL/PCP não contam aqui (têm tela própria no módulo Portais).
    const base = interessesData.filter(l => !ehPortalProprio(l));
    const comCompraId = base.filter(l => l.compraId && !l.compraId.startsWith('NAO_COMPRASNET:')).length;
    const naoComprasnet = base.filter(l => l.compraId?.startsWith('NAO_COMPRASNET:')).length;
    const pendentesCompraId = base.length - comCompraId - naoComprasnet;
    document.getElementById('statsInfo').innerHTML =
        `${base.length} interesses | ${comCompraId} Comprasnet | ${naoComprasnet ? naoComprasnet + ' estadual/municipal | ' : ''}${pendentesCompraId} pendentes`;
}

function renderizarTudo(allParticipacoes) {
    const loading = document.getElementById('loadingContainer');
    const container = document.getElementById('participacoesContainer');
    const empty = document.getElementById('emptyState');

    construirParticipacoes(allParticipacoes);
    loading.style.display = 'none';

    if (participacoesData.length === 0) {
        empty.style.display = 'block';
        return;
    }

    carregarValoresLocal();
    disputasData.forEach((disputa, compraId) => {
        if (disputa.fonte === 'interesse') {
            disputa.itens.forEach(item => {
                const dados = getValorItem(compraId, item.numero);
                if (!dados.valor && item.valorEstimado) {
                    setValorItem(compraId, item.numero, { valor: item.valorEstimado, selecionado: true });
                }
            });
        }
    });

    renderizarParticipacoes();
    container.style.display = 'block';
    document.getElementById('filtrosContainer').style.display = 'block';
    popularFiltros();
    atualizarStats();
}

async function carregarParticipacoes() {
    const loading = document.getElementById('loadingContainer');

    try {
        // 1. Carregar tudo em paralelo
        const [iResp, pResp, dResp] = await Promise.all([
            fetch('/api/proposta/interesses'),
            fetch('/api/proposta/participacoes').catch(() => null),
            fetch('/api/sniper/disputas-ativas').catch(() => null),
        ]);

        interessesData = ((await iResp.json()).data) || [];

        allParticipacoes = [];
        if (pResp) try { allParticipacoes = ((await pResp.json()).data) || []; } catch (e) {}

        if (dResp) try {
            const dResult = await dResp.json();
            if (dResult.disputas) dResult.disputas.forEach(d => disputasData.set(d.compraId, d));
        } catch (e) {}

        // 2. Rehidratar valores persistidos (marca/modelo/valor) antes de renderizar
        await carregarValoresDoBanco();

        // 3. Renderizar imediatamente com o que temos
        renderizarTudo(allParticipacoes);

        // 3. Auto-resolver compraId em background (não bloqueia a tela)
        const semCompraId = interessesData.filter(l => !l.compraId);
        if (semCompraId.length > 0) {
            resolverCompraIdsBackground(allParticipacoes);
        }

    } catch (error) {
        console.error('Erro:', error);
        loading.innerHTML = '<h3 style="color: #f44336;">Erro ao carregar participações</h3>';
    }
}

async function resolverCompraIdsBackground(allParticipacoes) {
    try {
        await fetch('/api/proposta/backfill-chave-pncp', { method: 'POST' });
        const arResp = await fetch('/api/proposta/interesses/auto-compra-id', { method: 'POST' });
        const arResult = await arResp.json();
        if (arResult.resolvidos?.length > 0) {
            // Recarregar interesses atualizados e re-renderizar
            const iResp = await fetch('/api/proposta/interesses');
            interessesData = ((await iResp.json()).data) || [];
            renderizarTudo(allParticipacoes);
        }
    } catch (e) { console.warn('Auto-resolve compraId background:', e); }
}

// ==================== FILTROS ====================

function popularFiltros() {
    // ESTADO DE TRABALHO (server-side): expressar ação requerida.
    // Buckets reflexam o que o usuário precisa fazer, não o código bruto Comprasnet.
    const estado = { 'sem-compraid': 0, 'a-enviar': 0, 'enviada': 0, 'em-disputa': 0, 'encerrada': 0, 'suspensa': 0 };
    // participacoesData é construído a partir de interessesData (1:1 por compraId).
    // Contar apenas um dos dois — senão cada item aparece em duplicidade no filtro.
    participacoesData.forEach(p => { if (estado[p.estadoTrabalho] !== undefined) estado[p.estadoTrabalho]++; });

    const total = participacoesData.length;

    // Contagem secundária (situação crua do Comprasnet) — usada no "avançado"
    const contagem = {};
    participacoesData.forEach(p => {
        if (p.situacao) contagem[p.situacao] = (contagem[p.situacao] || 0) + 1;
    });

    const select = document.getElementById('filtroSituacao');
    select.innerHTML = '';

    const opt = (val, label, count) => {
        select.innerHTML += `<option value="${val}">${label} (${count})</option>`;
    };

    // Buckets de trabalho — ordem reflete prioridade
    if (estado['sem-compraid'])  opt('sem-compraid', '🟠 Resolver CompraId',   estado['sem-compraid']);
    opt('a-enviar',  '🟡 A enviar',                                            estado['a-enviar']);
    opt('enviada',   '🟢 Proposta enviada',                                    estado['enviada']);
    if (estado['em-disputa']) opt('em-disputa', '🔴 Em disputa',               estado['em-disputa']);
    if (estado['suspensa'])   opt('suspensa',   '⚪ Suspensa',                 estado['suspensa']);
    opt('encerrada', '⚫ Encerrada',                                           estado['encerrada']);
    select.innerHTML += `<option disabled>────────────</option>`;
    opt('',          'Todas as licitações',                                    total);

    // Avançado: situações cruas do Comprasnet (escondidas atrás de um separador)
    if (Object.keys(contagem).length > 0) {
        select.innerHTML += `<option disabled>── Avançado (situação crua) ──</option>`;
        const ordemAtivas = ['PD', 'AB', '5', 'SU'];
        const ordemEncerradas = ['EN', '2', 'FR', 'EX'];
        [...ordemAtivas, ...ordemEncerradas].forEach(s => {
            if (contagem[s]) opt(s, formatarSituacao(s), contagem[s]);
        });
        const mapeadas = new Set([...ordemAtivas, ...ordemEncerradas]);
        const extras = Object.keys(contagem).filter(s => !mapeadas.has(s));
        extras.sort().forEach(s => { if (contagem[s]) opt(s, formatarSituacao(s), contagem[s]); });
    }

    // Popular filtro de Órgão
    const orgaos = {};
    participacoesData.forEach(p => {
        if (p.orgao) orgaos[p.orgao] = (orgaos[p.orgao] || 0) + 1;
    });
    const selectOrgao = document.getElementById('filtroOrgao');
    selectOrgao.innerHTML = `<option value="">Todos os órgãos (${Object.keys(orgaos).length})</option>`;
    Object.entries(orgaos).sort((a, b) => b[1] - a[1]).forEach(([org, qtd]) => {
        const label = org.length > 40 ? org.substring(0, 40) + '…' : org;
        selectOrgao.innerHTML += `<option value="${org}" title="${org}">${label} (${qtd})</option>`;
    });

    // Popular filtro de Grupo de palavras-chave
    const grupos = {};
    participacoesData.forEach(p => {
        if (p.grupoNome) grupos[p.grupoNome] = (grupos[p.grupoNome] || 0) + 1;
    });
    const selectGrupo = document.getElementById('filtroGrupo');
    selectGrupo.innerHTML = `<option value="">Todos os grupos</option>`;
    const semGrupo = participacoesData.filter(p => !p.grupoNome).length;
    Object.entries(grupos).sort((a, b) => a[0].localeCompare(b[0])).forEach(([g, qtd]) => {
        selectGrupo.innerHTML += `<option value="${g}">${g} (${qtd})</option>`;
    });
    if (semGrupo > 0) {
        selectGrupo.innerHTML += `<option value="SEM_GRUPO">Sem grupo (${semGrupo})</option>`;
    }

    // Padrão: foco no que precisa de ação — A enviar
    select.value = 'a-enviar';
    aplicarFiltros();
}

function filtroDataPermite(dataSessao, filtroData) {
    if (!filtroData) return true;
    if (filtroData === 'sem-data') return !dataSessao;
    if (!dataSessao) return false;

    // Extrair apenas a parte da data (YYYY-MM-DD) para comparar sem fuso horário
    const dStr = dataSessao.substring(0, 10); // "2026-02-27"
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dStr)) return false;

    const agora = new Date();
    const pad = n => String(n).padStart(2, '0');
    const hojeStr = `${agora.getFullYear()}-${pad(agora.getMonth() + 1)}-${pad(agora.getDate())}`;

    const addDias = (baseStr, dias) => {
        const dt = new Date(baseStr + 'T12:00:00');
        dt.setDate(dt.getDate() + dias);
        return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    };

    switch (filtroData) {
        case 'hoje': return dStr === hojeStr;
        case 'amanha': return dStr === addDias(hojeStr, 1);
        case '7dias': return dStr >= hojeStr && dStr <= addDias(hojeStr, 7);
        case 'vencidas': return dStr < hojeStr;
        default: return true;
    }
}

function aplicarFiltros() {
    const texto = document.getElementById('filtroTexto').value.toLowerCase().trim();
    const situacao = document.getElementById('filtroSituacao').value;
    const filtroData = (document.getElementById('filtroData') || {}).value || '';
    const orgao = (document.getElementById('filtroOrgao') || {}).value || '';
    const grupo = (document.getElementById('filtroGrupo') || {}).value || '';

    let total = 0, visiveis = 0;

    // Filtrar participações
    document.querySelectorAll('#participacoesContainer .panel[data-compra-id]').forEach(panel => {
        total++;
        const compraId = panel.dataset.compraId;
        const p = participacoesData.find(x => x.compraId === compraId);
        if (!p) return;

        let visivel = true;
        if (texto) {
            const t = `${p.objeto || ''} ${p.orgao || ''} ${p.compraId || ''}`.toLowerCase();
            if (!t.includes(texto)) visivel = false;
        }
        // Buckets de trabalho (estadoTrabalho server-side) vs situação crua Comprasnet
        const buckets = ['sem-compraid','a-enviar','enviada','em-disputa','encerrada','suspensa'];
        if (buckets.includes(situacao)) {
            if (p.estadoTrabalho !== situacao) visivel = false;
        } else if (situacao && p.situacao !== situacao) visivel = false;

        if (!filtroDataPermite(p.dataSessao, filtroData)) visivel = false;
        if (orgao && p.orgao !== orgao) visivel = false;
        if (grupo === 'SEM_GRUPO') {
            if (p.grupoNome) visivel = false;
        } else if (grupo && p.grupoNome !== grupo) visivel = false;

        panel.style.display = visivel ? '' : 'none';
        if (visivel) visiveis++;
    });

    // Filtrar interesses
    document.querySelectorAll('#interessesContainer .panel[data-interesse-key]').forEach(panel => {
        total++;
        const ikey = panel.dataset.interesseKey;
        const lic = interessesData.find(l => interesseKey(l) === ikey);
        if (!lic) return;

        let visivel = true;
        if (texto) {
            const t = `${lic.objetoCompra || ''} ${lic.nomeOrgao || ''} ${lic.compraId || ''} ${lic.codigoUnidade || ''} ${lic.numeroCompra || ''} ${lic.cnpj || ''}`.toLowerCase();
            if (!t.includes(texto)) visivel = false;
        }
        // Interesses têm estadoTrabalho = 'sem-compraid' ou 'a-enviar'.
        // Aparecem em "Todas" (sem filtro) e quando o bucket bate com o estado dela.
        if (situacao) {
            const buckets = ['sem-compraid','a-enviar','enviada','em-disputa','encerrada','suspensa'];
            if (buckets.includes(situacao)) {
                if (lic.estadoTrabalho !== situacao) visivel = false;
            } else {
                // Filtro de situação crua não se aplica a interesses (não passaram pelo Comprasnet)
                visivel = false;
            }
        }

        if (!filtroDataPermite(lic.dataEncerramentoProposta, filtroData)) visivel = false;

        // Filtro de órgão para interesses
        if (orgao && (lic.nomeOrgao || '') !== orgao) visivel = false;

        // Filtro de grupo para interesses
        if (grupo === 'SEM_GRUPO') {
            if (lic.grupoNome) visivel = false;
        } else if (grupo && (lic.grupoNome || '') !== grupo) visivel = false;

        panel.style.display = visivel ? '' : 'none';
        if (visivel) visiveis++;
    });

    const resultado = document.getElementById('filtroResultado');
    const temFiltroAtivo = texto || (situacao && situacao !== 'a-enviar') || filtroData || orgao || grupo;
    resultado.textContent = temFiltroAtivo ? `Exibindo ${visiveis} de ${total}` : '';
}

function limparFiltros() {
    document.getElementById('filtroTexto').value = '';
    document.getElementById('filtroSituacao').value = 'a-enviar';
    document.getElementById('filtroOrgao').value = '';
    document.getElementById('filtroData').value = '';
    document.getElementById('filtroGrupo').value = '';
    aplicarFiltros();
}

// ==================== RENDERIZAR ====================

function renderizarParticipacoes() {
    const container = document.getElementById('participacoesContainer');
    container.innerHTML = '';

    participacoesData.forEach(p => {
        const disputa = disputasData.get(p.compraId);
        const div = document.createElement('div');
        div.className = 'panel';
        div.dataset.compraId = p.compraId;

        const situacaoLabel = formatarSituacao(p.situacao);
        const faseLabel = p.faseCompra || p.etapa || '';

        const compraIdDisplay = p.semCompraId
            ? `<span class="badge-sem-compra">Sem CompraId</span>`
            : `<span class="badge-compra">${p.compraId}</span>`;

        const comprasnetLink = p.semCompraId ? '' :
            `<a href="https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=${p.compraId}"
               target="_blank" class="btn-comprasnet">Comprasnet</a>`;

        div.innerHTML = `
            <div class="participacao-header">
                <div class="participacao-info">
                    <div class="participacao-objeto">${p.objeto || 'Objeto não disponível'}</div>
                    <div class="participacao-orgao">${p.orgao || ''}</div>
                    <div class="participacao-meta">
                        ${badgeEstadoTrabalho(p.estadoTrabalho)}
                        ${compraIdDisplay}
                        ${p.situacao ? `<span class="badge-situacao badge-sit-${(p.situacao || '').toUpperCase()}" style="opacity:0.65; font-size:0.72em;" title="Situação Comprasnet: ${situacaoLabel}">${p.situacao}</span>` : ''}
                        ${faseLabel ? `<span class="badge-fase">${faseLabel}</span>` : ''}
                        ${p.propostaEnviadaEm ? `<span class="meta-data" title="Proposta enviada em">📤 ${formatarData(p.propostaEnviadaEm)}</span>` : ''}
                        ${p.dataSessao ? `<span class="meta-data">${formatarData(p.dataSessao)}</span>` : ''}
                    </div>
                </div>
                <div class="participacao-acoes">
                    ${comprasnetLink}
                </div>
            </div>

            <div class="itens-container" id="itens-${p.compraId}">
                ${disputa && disputa.itens?.length > 0
                    ? renderizarItens(p.compraId, disputa.itens)
                    : p.semCompraId
                        ? `<div class="empty-itens">Vincule o CompraId para carregar itens e enviar proposta</div>`
                        : `<div class="itens-loading" id="itens-loading-${p.compraId}">
                             <button class="btn btn-secondary btn-sm" onclick="carregarItens('${p.compraId}')">
                               Carregar itens
                             </button>
                           </div>`
                }
            </div>

            ${p.semCompraId ? '' : `
            <div class="participacao-actions" id="actions-${p.compraId}" ${!disputa ? 'style="display:none"' : ''}>
                <button class="btn-action btn-enviar" onclick="enviarProposta('${p.compraId}')">
                    Enviar Proposta
                </button>
                <button class="btn-action btn-pdf" onclick="gerarPDFParticipacao('${p.compraId}', false)">
                    PDF Orçamento
                </button>
                <button class="btn-action btn-pdf-assinado" onclick="gerarPDFParticipacao('${p.compraId}', true)">
                    PDF Assinado
                </button>
                <button class="btn-action btn-excluir" onclick="excluirProposta('${p.compraId}')">
                    Excluir Proposta
                </button>
            </div>
            `}
        `;
        container.appendChild(div);
    });
}

function renderizarItens(compraId, itens) {
    if (!itens || itens.length === 0) return '<div class="empty-itens">Sem itens disponíveis</div>';

    let html = `
        <div class="select-all-bar">
            <input type="checkbox" id="selectAll-${compraId}" onchange="toggleSelectAll('${compraId}')">
            <label for="selectAll-${compraId}">Selecionar todos</label>
            <span class="badge-qtd">${itens.length} itens</span>
        </div>
        <div class="itens-grid">
            <div class="item-header-row" style="grid-template-columns: 30px 1fr 60px 110px 0.9fr 0.9fr;">
                <div></div>
                <div>Item / Descrição</div>
                <div>Qtde</div>
                <div>Valor Proposta</div>
                <div>Marca / Modelo</div>
                <div>Produto da empresa</div>
            </div>
    `;

    itens.forEach(item => {
        const num = item.numero;
        const dados = getValorItem(compraId, num);
        const sit = item.situacaoParticipante || '';
        const sitLabel = {
            G: 'Ganhando', P: 'Participando', C: 'Reafirmado',
            D: 'Desclassif.', I: 'Excluída', A: 'Desclassif.',
            F: 'Desclassif.', R: 'Recusada'
        }[sit] || sit || '-';

        html += `
            <div class="item-row ${dados.selecionado ? 'selecionado' : ''}" id="row-${compraId}-${num}" style="grid-template-columns: 30px 1fr 60px 110px 0.9fr 0.9fr;">
                <div>
                    <input type="checkbox" class="item-checkbox"
                           id="chk-${compraId}-${num}"
                           ${dados.selecionado ? 'checked' : ''}
                           onchange="toggleItem('${compraId}', ${num})">
                </div>
                <div class="item-desc">
                    <span class="item-num">Item ${num}</span>
                    <span class="item-texto">${item.descricao || ''}</span>
                    ${item.valorEstimado ? `<span class="item-ref">Ref: ${fmtValor(item.valorEstimado)}</span>` : ''}
                </div>
                <div class="item-input-cell">
                    <input type="number" step="1" min="1"
                           id="qtd-${compraId}-${num}"
                           value="${dados.quantidade || item.quantidade || 1}"
                           style="width:60px; text-align:center"
                           onchange="atualizarExtra('${compraId}', ${num}, 'quantidade', this.value)">
                </div>
                <div class="item-input-cell">
                    <input type="number" step="0.01" min="0"
                           id="val-${compraId}-${num}"
                           value="${dados.valor || ''}"
                           placeholder="0,00"
                           onchange="atualizarValor('${compraId}', ${num}, this.value)"
                           onfocus="autoSelect('${compraId}', ${num})">
                </div>
                <div class="item-extras-cell">
                    <input type="text" id="marca-${compraId}-${num}" value="${dados.marca || ''}"
                           placeholder="Marca" onchange="atualizarExtra('${compraId}', ${num}, 'marca', this.value)">
                    <input type="text" id="modelo-${compraId}-${num}" value="${dados.modelo || ''}"
                           placeholder="Modelo" onchange="atualizarExtra('${compraId}', ${num}, 'modelo', this.value)">
                </div>
                <div id="match-${compraId}-${num}">${renderProdutoMatch(compraId, num)}</div>
            </div>
        `;
    });

    html += '</div>';
    return html;
}

// ==================== CARREGAR ITENS INDIVIDUAL ====================

async function carregarItens(compraId) {
    const container = document.getElementById(`itens-${compraId}`);

    // 1. Verificar se já tem itens de interesse cruzados
    const interesse = interessesData.find(l => l.compraId === compraId && l.itens?.length > 0);
    if (interesse) {
        const itens = interesse.itens.map(it => ({
            numero: it.numero,
            descricao: it.descricao,
            quantidade: it.quantidade || 1,
            unidadeMedida: it.unidadeMedida,
            valorEstimado: it.valorEstimado,
            melhorValor: null,
            nossoValor: null,
            situacaoParticipante: null,
        }));
        disputasData.set(compraId, {
            compraId, itens,
            orgao: interesse.nomeOrgao, objeto: interesse.objetoCompra,
            fonte: 'interesse',
        });
        // Auto-preencher valores de referência e selecionar
        itens.forEach(item => {
            const dados = getValorItem(compraId, item.numero);
            if (!dados.valor && item.valorEstimado) {
                setValorItem(compraId, item.numero, { valor: item.valorEstimado, selecionado: true });
            }
        });
        container.innerHTML = renderizarItens(compraId, itens);
        const actions = document.getElementById(`actions-${compraId}`);
        if (actions) actions.style.display = '';
        return;
    }

    // 2. Buscar via API
    container.innerHTML = '<div class="itens-loading">Carregando itens...</div>';
    try {
        // Buscar itens e valores salvos em paralelo
        const [resp, valoresResp] = await Promise.all([
            fetch(`/api/proposta/itens-compra/${compraId}`),
            fetch(`/api/proposta/valores-compra/${compraId}`).catch(() => null),
        ]);
        const result = await resp.json();
        const valoresDB = valoresResp ? (await valoresResp.json()).valores || {} : {};

        if (result.success && result.itens?.length > 0) {
            disputasData.set(compraId, {
                compraId,
                itens: result.itens,
                orgao: result.orgao || '',
                objeto: result.objeto || '',
            });
            // Preencher com valores do banco (marca, modelo, valor) e depois com REF
            result.itens.forEach(item => {
                const dbVal = valoresDB[item.numero];
                const dados = getValorItem(compraId, item.numero);
                if (dbVal) {
                    // DB tem prioridade se localStorage não tem valor
                    if (!dados.valor && dbVal.valor) setValorItem(compraId, item.numero, { valor: dbVal.valor, selecionado: true });
                    if (!dados.marca && dbVal.marca) setValorItem(compraId, item.numero, { marca: dbVal.marca });
                    if (!dados.modelo && dbVal.modelo) setValorItem(compraId, item.numero, { modelo: dbVal.modelo });
                }
                // Fallback: valor estimado como referência
                const dadosAtual = getValorItem(compraId, item.numero);
                if (!dadosAtual.valor && item.valorEstimado) {
                    setValorItem(compraId, item.numero, { valor: item.valorEstimado, selecionado: true });
                }
            });
            container.innerHTML = renderizarItens(compraId, result.itens);
            const actions = document.getElementById(`actions-${compraId}`);
            if (actions) actions.style.display = '';
        } else {
            container.innerHTML = `<div class="empty-itens">
                ${result.error || 'Nenhum item encontrado'}
                <br><small>Fonte: ${result.fonte || 'api'}</small>
                <br><button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="participarEListar('${compraId}')">
                    Participar e carregar itens
                </button>
            </div>`;
        }
    } catch (error) {
        container.innerHTML = `<div class="empty-itens" style="color:#f44336;">
            Erro: ${error.message}
        </div>`;
    }
}

async function participarEListar(compraId) {
    const container = document.getElementById(`itens-${compraId}`);
    container.innerHTML = '<div class="itens-loading">Aceitando declarações e carregando itens...</div>';

    try {
        const resp = await fetch(`/api/proposta/participar-e-listar/${compraId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                declaracaoMeEpp: fornecedorConfig?.declaracaoMeEpp == 1,
                declaracaoProgramasIntegridade: fornecedorConfig?.declaracaoProgramasIntegridade == 1,
                declaracaoEquidadeGenero: fornecedorConfig?.declaracaoEquidadeGenero == 1,
            })
        });
        const result = await resp.json();

        if (result.success && result.itens?.length > 0) {
            disputasData.set(compraId, {
                compraId,
                itens: result.itens,
                orgao: '',
                objeto: '',
            });
            // Auto-preencher valor REF e selecionar
            result.itens.forEach(item => {
                const dados = getValorItem(compraId, item.numero);
                if (!dados.valor && item.valorEstimado) {
                    setValorItem(compraId, item.numero, { valor: item.valorEstimado, selecionado: true });
                }
            });
            container.innerHTML = renderizarItens(compraId, result.itens);
            const actions = document.getElementById(`actions-${compraId}`);
            if (actions) actions.style.display = '';
        } else {
            const etapasInfo = result.etapas
                ? result.etapas.map(e => `${e.etapa}: ${e.sucesso ? 'OK' : e.erro || 'HTTP ' + e.status}`).join(' → ')
                : '';
            container.innerHTML = `<div class="empty-itens">
                ${result.error || 'Não foi possível listar itens'}
                ${etapasInfo ? `<br><small>${etapasInfo}</small>` : ''}
            </div>`;
        }
    } catch (error) {
        container.innerHTML = `<div class="empty-itens" style="color:#f44336;">
            Erro: ${error.message}
        </div>`;
    }
}

// ==================== INTERAÇÃO ====================

function toggleItem(compraId, numero) {
    const chk = document.getElementById(`chk-${compraId}-${numero}`);
    const row = document.getElementById(`row-${compraId}-${numero}`);
    setValorItem(compraId, numero, { selecionado: chk.checked });
    row.classList.toggle('selecionado', chk.checked);
    persistirItemBanco(compraId, numero);
    atualizarResumo();
}

function toggleSelectAll(compraId) {
    const chk = document.getElementById(`selectAll-${compraId}`);
    const disputa = disputasData.get(compraId);
    if (!disputa) return;

    disputa.itens.forEach(item => {
        setValorItem(compraId, item.numero, { selecionado: chk.checked });
        const itemChk = document.getElementById(`chk-${compraId}-${item.numero}`);
        const row = document.getElementById(`row-${compraId}-${item.numero}`);
        if (itemChk) itemChk.checked = chk.checked;
        if (row) row.classList.toggle('selecionado', chk.checked);
        persistirItemBanco(compraId, item.numero);
    });
    atualizarResumo();
}

function autoSelect(compraId, numero) {
    const chk = document.getElementById(`chk-${compraId}-${numero}`);
    if (!chk.checked) {
        chk.checked = true;
        toggleItem(compraId, numero);
    }
}

function atualizarValor(compraId, numero, valor) {
    setValorItem(compraId, numero, { valor: parseFloat(valor) || null });
    persistirItemBanco(compraId, numero);
    atualizarResumo();
}

function atualizarExtra(compraId, numero, campo, valor) {
    setValorItem(compraId, numero, { [campo]: valor });
    if (campo === 'marca' || campo === 'modelo' || campo === 'fabricante') {
        persistirItemBanco(compraId, numero);
    }
}

// ==================== RESUMO ====================

function atualizarResumo() {
    const resumoDiv = document.getElementById('resumoGeral');
    const conteudo = document.getElementById('resumoConteudo');

    let totalItens = 0;
    let totalValor = 0;
    let comprasComItens = new Set();

    Object.entries(valoresLocais).forEach(([key, dados]) => {
        if (dados.selecionado && dados.valor > 0) {
            totalItens++;
            totalValor += dados.valor;
            comprasComItens.add(key.split(':')[0]);
        }
    });

    if (totalItens === 0) {
        resumoDiv.style.display = 'none';
        return;
    }

    resumoDiv.style.display = 'block';
    conteudo.innerHTML = `
        <div class="resumo-grid">
            <div class="resumo-item"><span>Licitações</span><span>${comprasComItens.size}</span></div>
            <div class="resumo-item"><span>Itens selecionados</span><span>${totalItens}</span></div>
            <div class="resumo-total"><span>TOTAL</span><span>${fmtValor(totalValor)}</span></div>
        </div>
    `;
}

// ==================== EXCLUSÃO ====================

async function excluirProposta(compraId) {
    if (!confirm(`Tem certeza que deseja EXCLUIR a proposta da compra ${compraId}?\n\nIsso remove a participação e todas as propostas de itens.`)) {
        return;
    }

    const btn = event.target;
    btn.disabled = true;
    btn.textContent = 'Excluindo...';

    try {
        const resp = await fetch(`/api/proposta/excluir/${compraId}`, { method: 'DELETE' });
        const result = await resp.json();

        if (result.success) {
            alert(`Proposta excluída com sucesso.\n\n${result.message || ''}`);
            // Recarregar a página para refletir o estado atualizado
            location.reload();
        } else {
            alert(`Erro ao excluir: ${result.error || 'Erro desconhecido'}`);
            btn.disabled = false;
            btn.textContent = 'Excluir Proposta';
        }
    } catch (error) {
        alert(`Erro de conexão: ${error.message}`);
        btn.disabled = false;
        btn.textContent = 'Excluir Proposta';
    }
}

// ==================== ENVIO ====================

async function enviarProposta(compraId) {
    const disputa = disputasData.get(compraId);
    if (!disputa) {
        alert('Carregue os itens primeiro.');
        return;
    }

    // Coletar itens selecionados
    const itensSelecionados = [];
    disputa.itens.forEach(item => {
        const dados = getValorItem(compraId, item.numero);
        if (dados.selecionado && dados.valor > 0) {
            itensSelecionados.push({
                numero: item.numero,
                valor: dados.valor,
                quantidade: item.quantidade || 1,
                marca: dados.marca || '',
                modelo: dados.modelo || '',
            });
        }
    });

    if (itensSelecionados.length === 0) {
        alert('Selecione ao menos um item com valor definido.');
        return;
    }

    // Declarações vêm da config do fornecedor (minha-empresa.html)
    const declaracoes = {
        declaracaoMeEpp: fornecedorConfig?.declaracaoMeEpp == 1,
        declaracaoProgramasIntegridade: fornecedorConfig?.declaracaoProgramasIntegridade == 1,
        declaracaoEquidadeGenero: fornecedorConfig?.declaracaoEquidadeGenero == 1,
    };

    // Encontrar o card da compra para mostrar progresso inline
    const card = document.querySelector(`[data-compra-id="${compraId}"]`);
    const btnEnviar = card?.querySelector('.btn-enviar');
    if (btnEnviar) {
        btnEnviar.disabled = true;
        btnEnviar.textContent = 'Enviando...';
    }

    // Criar área de log inline no card
    let logArea = card?.querySelector('.envio-log-inline');
    if (!logArea && card) {
        logArea = document.createElement('div');
        logArea.className = 'envio-log-inline';
        logArea.style.cssText = 'margin-top:10px; padding:10px; background:#1a1a2e; border-radius:6px; font-size:0.85em; max-height:200px; overflow-y:auto;';
        card.appendChild(logArea);
    }
    if (logArea) logArea.innerHTML = '<div style="color:#aaa;">Aceitando termos e declarações...</div>';

    try {
        const resp = await fetch('/api/proposta/enviar-api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ compraId, itens: itensSelecionados, declaracoes })
        });

        const result = await resp.json();

        if (logArea) {
            logArea.innerHTML = '';

            if (result.success) {
                logArea.innerHTML += `<div style="color:#4caf50; font-weight:600; margin-bottom:6px;">${result.message}</div>`;
            } else {
                logArea.innerHTML += `<div style="color:#f44336; font-weight:600; margin-bottom:6px;">${result.error || result.message}</div>`;
            }

            if (result.resultados) {
                result.resultados.forEach(r => {
                    if (r.fase === 'declaracoes') {
                        const cor = r.sucesso ? '#4caf50' : '#f44336';
                        logArea.innerHTML += `<div style="color:${cor};">
                            Declarações: ${r.sucesso ? 'OK' : 'Falha'}
                            ${r.info ? `(${r.info})` : ''}
                            ${r.status ? `(HTTP ${r.status})` : ''}
                            ${r.erro ? `- ${r.erro}` : ''}
                        </div>`;
                    } else {
                        const cor = r.sucesso ? '#4caf50' : '#f44336';
                        logArea.innerHTML += `<div style="color:${cor};">
                            Item ${r.numero}: ${r.sucesso ? 'OK' : 'Falha'}
                            ${r.status ? `(HTTP ${r.status})` : ''}
                            ${r.erro ? `- ${r.erro}` : ''}
                        </div>`;
                    }
                });
            }

            // Atualizar UI local para refletir que proposta foi enviada
            if (result.success) {
                const p = participacoesData.find(x => x.compraId === compraId);
                if (p) p.propostaEnviadaEm = new Date().toISOString();

                // Atualizar badge de situação no card
                const badgeSit = card?.querySelector('.badge-situacao');
                if (badgeSit) {
                    badgeSit.className = 'badge-situacao badge-sit-PE';
                    badgeSit.textContent = 'Proposta Enviada';
                }

                // Atualizar contadores no filtro de situação
                popularFiltros();
            }

        }

    } catch (error) {
        if (logArea) logArea.innerHTML = `<div style="color:#f44336;">Erro de conexão: ${error.message}</div>`;
    }

    if (btnEnviar) {
        btnEnviar.disabled = false;
        btnEnviar.textContent = 'Enviar Proposta';
    }
}

// ==================== UTILS ====================

function fmtValor(valor) {
    if (valor == null) return '-';
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor);
}

function formatarSituacao(sit) {
    const map = {
        'PD': 'Em Disputa', 'AB': 'Aberta', 'EN': 'Encerrada',
        'FR': 'Fracassada', 'PE': 'Proposta Enviada',
        'SU': 'Suspensa', 'EX': 'Excluída',
        '5': 'Em Andamento', '2': 'Encerrada',
    };
    return map[(sit || '').toUpperCase()] || sit || '-';
}

// Badge primário do card — reflete estado de trabalho do usuário (não código bruto Comprasnet).
// Mapeia para classes existentes em app-modern.css (badge-sit-* já cobrem as cores que precisamos).
function badgeEstadoTrabalho(estado) {
    const map = {
        'sem-compraid': { label: '🟠 Resolver CompraId',  cls: 'badge-sit-FR' }, // laranja/vermelho
        'a-enviar':     { label: '🟡 A enviar',           cls: 'badge-sit-PD' }, // accent
        'enviada':      { label: '🟢 Proposta enviada',   cls: 'badge-sit-PE' }, // verde
        'em-disputa':   { label: '🔴 Em disputa',         cls: 'badge-sit-EN' }, // danger
        'encerrada':    { label: '⚫ Encerrada',          cls: 'badge-sit-EX' }, // muted/danger
        'suspensa':     { label: '⚪ Suspensa',           cls: 'badge-sit-SU' }, // muted
    };
    const info = map[estado];
    if (!info) return '';
    return `<span class="badge-situacao ${info.cls}" style="font-weight:600;">${info.label}</span>`;
}

function formatarData(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleDateString('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch (e) { return iso; }
}

// ==================== INTERESSES ====================

function mostrarInteresses() {
    // interessesData já está carregado — filtrar os que já aparecem como participações
    const participacoesIds = new Set(participacoesData.map(p => p.compraId));
    const extras = interessesData.filter(lic => (!lic.compraId || !participacoesIds.has(lic.compraId)) && !ehPortalProprio(lic));

    if (extras.length === 0) return;

    const section = document.getElementById('interessesSection');
    section.style.display = 'block';
    document.getElementById('interessesBadge').textContent = extras.length;

    if (participacoesData.length > 0) {
        document.getElementById('separadorSections').style.display = 'block';
    }

    renderizarInteresses();
    aplicarFiltros();
}

function toggleInteresses() {
    interessesVisiveis = !interessesVisiveis;
    document.getElementById('interessesContainer').style.display = interessesVisiveis ? '' : 'none';
    document.getElementById('interessesToggle').textContent = interessesVisiveis ? '▼' : '▶';
}

function interesseKey(lic) {
    return `interesse-${lic.cnpj}-${lic.ano}-${lic.sequencial}`;
}

// BNC/BLL/PCP têm tela própria de proposta no módulo Portais — não fazem sentido
// nesta página (Comprasnet, via API). Escondemos esses interesses aqui.
function ehPortalProprio(lic) {
    return /bnccompras\.com|bllcompras\.com|portaldecompraspublicas\.com\.br/i.test(lic.linkSistemaOrigem || '');
}

function renderizarInteresses() {
    const container = document.getElementById('interessesContainer');
    container.innerHTML = '';

    interessesData.filter(lic => !ehPortalProprio(lic)).forEach(lic => {
        const ikey = interesseKey(lic);
        // Para itens de interesse, usar compraId se disponível, senão usar a key de interesse
        const itemPrefix = lic.compraId || ikey;

        // Pre-carregar itens no disputasData para toggleSelectAll/enviarProposta funcionar
        if (lic.itens?.length > 0 && !disputasData.has(itemPrefix)) {
            disputasData.set(itemPrefix, {
                compraId: lic.compraId || null,
                itens: lic.itens.map(it => ({
                    numero: it.numero,
                    descricao: it.descricao,
                    quantidade: it.quantidade,
                    unidadeMedida: it.unidadeMedida,
                    valorEstimado: it.valorEstimado,
                    melhorValor: null,
                    nossoValor: null,
                    situacaoParticipante: null
                })),
                orgao: lic.nomeOrgao,
                objeto: lic.objetoCompra
            });
        }

        const div = document.createElement('div');
        div.className = 'panel interesse-panel';
        div.dataset.interesseKey = ikey;
        if (lic.compraId) div.dataset.compraId = lic.compraId;

        const naoComprasnet = lic.compraId?.startsWith('NAO_COMPRASNET:');
        const sistemaOrigem = naoComprasnet ? lic.compraId.replace('NAO_COMPRASNET:', '') : null;
        const compraIdReal = lic.compraId && !naoComprasnet ? lic.compraId : null;

        const compraIdHtml = naoComprasnet
            ? `<span class="badge-sem-compra" style="background:#ff9800; color:#000;">Sistema: ${sistemaOrigem}</span>`
            : compraIdReal
                ? `<span class="badge-com-compra">CompraId: ${compraIdReal}</span>`
                : `<span class="badge-sem-compra">Sem CompraId</span>`;

        div.innerHTML = `
            <div class="participacao-header">
                <div class="participacao-info">
                    <div class="participacao-objeto">${lic.objetoCompra}</div>
                    <div class="participacao-orgao">${lic.nomeOrgao}</div>
                    <div class="participacao-meta">
                        ${badgeEstadoTrabalho(lic.estadoTrabalho)}
                        ${compraIdHtml}
                        <span class="badge-compra">${lic.numeroCompra || lic.sequencial}/${lic.ano}</span>
                        ${lic.modalidadeNome ? `<span class="badge-fase">${lic.modalidadeNome}</span>` : ''}
                        ${lic.dataEncerramentoProposta ? `<span class="meta-data">Encerra: ${formatarData(lic.dataEncerramentoProposta)}</span>` : ''}
                    </div>
                </div>
                <div class="participacao-acoes" style="display:flex; gap:6px;">
                    ${compraIdReal ? `<a href="https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=${compraIdReal}"
                       target="_blank" class="btn-comprasnet">Comprasnet</a>` : ''}
                    ${lic.linkSistemaOrigem ? `<a href="${lic.linkSistemaOrigem.startsWith('http') ? lic.linkSistemaOrigem : 'https://' + lic.linkSistemaOrigem}"
                       target="_blank" class="btn-comprasnet" style="background:#ff9800;">Sistema</a>` : ''}
                </div>
            </div>

            ${!compraIdReal && !naoComprasnet ? `
            <div class="compra-id-bar" id="compraIdBar-${ikey}">
                <label style="color:#aaa; font-size:0.82em; white-space:nowrap;">CompraId Comprasnet:</label>
                <input type="text" id="compraIdInput-${ikey}" placeholder="Ex: 92687906001182026"
                       maxlength="20" pattern="[0-9]*" inputmode="numeric">
                <button class="btn-verificar" onclick="verificarCompraId('${ikey}')">Verificar</button>
                <button class="btn-verificar" onclick="autoResolverCompraId('${ikey}', this)" style="background:#ff9800; color:#000;" title="Tenta resolver via PNCP + UASG automaticamente">🔍 Auto</button>
                <span class="status-msg" id="compraIdStatus-${ikey}"></span>
            </div>
            ` : ''}

            <div class="itens-container" id="itens-${itemPrefix}">
                ${lic.itens?.length > 0
                    ? renderizarItensInteresse(itemPrefix, lic)
                    : '<div class="empty-itens">Nenhum item de interesse</div>'
                }
            </div>

            <div class="participacao-actions" id="actions-interesse-${ikey}">
                ${compraIdReal ? `
                    <button class="btn-action btn-enviar" onclick="enviarProposta('${compraIdReal}')">
                        Enviar Proposta
                    </button>
                    <button class="btn-action btn-pdf" onclick="gerarPDFParticipacao('${compraIdReal}', false)">
                        PDF Orçamento
                    </button>
                    <button class="btn-action btn-pdf-assinado" onclick="gerarPDFParticipacao('${compraIdReal}', true)">
                        PDF Assinado
                    </button>
                ` : naoComprasnet ? `
                    <span style="color:#ff9800; font-size:0.82em;">Envio via API indisponivel (sistema estadual/municipal)</span>
                ` : `
                    <span style="color:#888; font-size:0.82em;">Resolução automática pendente</span>
                `}
            </div>
        `;
        container.appendChild(div);
    });
}

function renderizarItensInteresse(itemPrefix, lic) {
    const itens = lic.itens || [];
    if (itens.length === 0) return '<div class="empty-itens">Sem itens</div>';

    let html = `
        <div class="select-all-bar">
            <input type="checkbox" id="selectAll-${itemPrefix}" onchange="toggleSelectAll('${itemPrefix}')">
            <label for="selectAll-${itemPrefix}">Selecionar todos</label>
            <span class="badge-qtd">${itens.length} itens</span>
        </div>
        <div class="itens-grid">
            <div class="item-header-row" style="grid-template-columns: 30px 1fr 80px 60px 110px 0.9fr 50px 0.9fr;">
                <div></div>
                <div>Item / Descrição</div>
                <div>Ref R$</div>
                <div>Qtde</div>
                <div>Valor Proposta</div>
                <div>Marca / Modelo</div>
                <div>Unid</div>
                <div>Produto da empresa</div>
            </div>
    `;

    itens.forEach(item => {
        const num = item.numero;
        const dados = getValorItem(itemPrefix, num);

        html += `
            <div class="item-row ${dados.selecionado ? 'selecionado' : ''}" id="row-${itemPrefix}-${num}" style="grid-template-columns: 30px 1fr 80px 60px 110px 0.9fr 50px 0.9fr;">
                <div>
                    <input type="checkbox" class="item-checkbox"
                           id="chk-${itemPrefix}-${num}"
                           ${dados.selecionado ? 'checked' : ''}
                           onchange="toggleItem('${itemPrefix}', ${num})">
                </div>
                <div class="item-desc">
                    <span class="item-num">Item ${num}</span>
                    <span class="item-texto">${item.descricao || ''}</span>
                </div>
                <div class="item-valor">${item.valorEstimado != null ? fmtValor(item.valorEstimado) : '-'}</div>
                <div class="item-input-cell">
                    <input type="number" step="1" min="1"
                           id="qtd-${itemPrefix}-${num}"
                           value="${item.quantidade || 1}"
                           style="width:60px; text-align:center"
                           onchange="atualizarExtra('${itemPrefix}', ${num}, 'quantidade', this.value)">
                </div>
                <div class="item-input-cell">
                    <input type="number" step="0.01" min="0"
                           id="val-${itemPrefix}-${num}"
                           value="${dados.valor || ''}"
                           placeholder="0,00"
                           onchange="atualizarValor('${itemPrefix}', ${num}, this.value)"
                           onfocus="autoSelect('${itemPrefix}', ${num})">
                </div>
                <div class="item-extras-cell">
                    <input type="text" id="marca-${itemPrefix}-${num}" value="${dados.marca || ''}"
                           placeholder="Marca" onchange="atualizarExtra('${itemPrefix}', ${num}, 'marca', this.value)">
                    <input type="text" id="modelo-${itemPrefix}-${num}" value="${dados.modelo || ''}"
                           placeholder="Modelo" onchange="atualizarExtra('${itemPrefix}', ${num}, 'modelo', this.value)">
                </div>
                <div style="font-size:0.78em; color:#888;">${item.unidadeMedida || 'UN'}</div>
                <div id="match-${itemPrefix}-${num}">${renderProdutoMatch(itemPrefix, num)}</div>
            </div>
        `;
    });

    html += '</div>';
    return html;
}

async function autoResolverCompraId(ikey, btn) {
    const status = document.getElementById(`compraIdStatus-${ikey}`);
    const labelOriginal = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Resolvendo...';
    status.innerHTML = '<span style="color:#4dabf7;">Consultando PNCP + UASG…</span>';
    try {
        const r = await fetch('/api/proposta/interesses/auto-compra-id', { method: 'POST' });
        const d = await r.json();
        if (!d.success) {
            status.innerHTML = `<span style="color:#f44336;">Falha: ${d.error || 'erro'}</span>`;
            return;
        }
        // Recarregar dados pra refletir resolvidos
        const iResp = await fetch('/api/proposta/interesses');
        const iJson = await iResp.json();
        interessesData = iJson.data || [];
        renderizarTudo(allParticipacoes);
        const resolvidos = (d.resolvidos || []).length;
        const naoCS = (d.naoComprasnet || []).length;
        status.innerHTML = `<span style="color:#4caf50;">${resolvidos} resolvidos · ${naoCS} não-Comprasnet</span>`;
    } catch (e) {
        status.innerHTML = `<span style="color:#f44336;">Erro: ${e.message}</span>`;
    } finally {
        btn.disabled = false;
        btn.textContent = labelOriginal;
    }
}

async function verificarCompraId(ikey) {
    const input = document.getElementById(`compraIdInput-${ikey}`);
    const status = document.getElementById(`compraIdStatus-${ikey}`);
    const compraId = input.value.trim();

    if (!compraId || !/^\d{14,20}$/.test(compraId)) {
        status.innerHTML = '<span style="color:#f44336;">Formato inválido (14-20 dígitos)</span>';
        return;
    }

    status.innerHTML = '<span style="color:#4dabf7;">Verificando...</span>';

    const lic = interessesData.find(l => interesseKey(l) === ikey);
    if (!lic) return;

    try {
        // Salvar compraId no servidor
        await fetch('/api/proposta/interesses/compra-id', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cnpj: lic.cnpj, ano: lic.ano, sequencial: lic.sequencial, compraId })
        });

        // Tentar carregar itens do Comprasnet para verificar
        const resp = await fetch(`/api/proposta/itens-compra/${compraId}`);
        const result = await resp.json();

        if (result.success && result.itens?.length > 0) {
            // Sucesso! Atualizar dados
            lic.compraId = compraId;
            disputasData.set(compraId, {
                compraId,
                itens: result.itens,
                orgao: result.orgao || lic.nomeOrgao,
                objeto: result.objeto || lic.objetoCompra
            });

            // Marcar como verificado
            await fetch('/api/proposta/interesses/compra-id/verificar', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cnpj: lic.cnpj, ano: lic.ano, sequencial: lic.sequencial })
            });

            status.innerHTML = `<span style="color:#4caf50;">OK — ${result.itens.length} itens encontrados (${result.fonte || 'api'})</span>`;

            // Atualizar a UI: mostrar itens do Comprasnet e habilitar ações
            const itensContainer = document.getElementById(`itens-${compraId}`) || document.getElementById(`itens-${ikey}`);
            if (itensContainer) {
                itensContainer.id = `itens-${compraId}`;
                itensContainer.innerHTML = renderizarItens(compraId, result.itens);
            }

            const actionsDiv = document.getElementById(`actions-interesse-${ikey}`);
            if (actionsDiv) {
                actionsDiv.innerHTML = `
                    <button class="btn-action btn-enviar" onclick="enviarProposta('${compraId}')">
                        Enviar Proposta
                    </button>
                `;
            }

            // Atualizar badge
            const panel = document.querySelector(`[data-interesse-key="${ikey}"]`);
            if (panel) {
                const badgeSem = panel.querySelector('.badge-sem-compra');
                if (badgeSem) {
                    badgeSem.className = 'badge-com-compra';
                    badgeSem.textContent = `CompraId: ${compraId}`;
                }
            }
        } else {
            status.innerHTML = `<span style="color:#ff9800;">CompraId salvo, mas ${result.error || 'sem itens retornados'}. Token ativo?</span>`;
            // Mesmo sem itens, permitir usar (pode ser token expirado)
            lic.compraId = compraId;
            const actionsDiv = document.getElementById(`actions-interesse-${ikey}`);
            if (actionsDiv) {
                actionsDiv.innerHTML = `
                    <button class="btn-action btn-enviar" onclick="enviarProposta('${compraId}')">
                        Enviar Proposta
                    </button>
                `;
            }
        }
    } catch (error) {
        status.innerHTML = `<span style="color:#f44336;">Erro: ${error.message}</span>`;
    }
}

// ==================== FORNECEDOR CONFIG ====================

async function carregarFornecedorConfig() {
    try {
        const resp = await fetch('/api/fornecedor');
        const result = await resp.json();
        if (result.success && result.data) {
            fornecedorConfig = result.data;
        }
    } catch (e) {
        console.warn('Erro ao carregar config fornecedor:', e);
    }
}

// ==================== INIT ====================

// ==================== GERAÇÃO DE PDF / ORÇAMENTO ====================

function formatarValorPDF(valor) {
    return 'R$ ' + valor.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

async function gerarPDFParticipacao(compraId, assinar = false) {
    const disputa = disputasData.get(compraId);
    if (!disputa || !disputa.itens?.length) {
        alert('Carregue os itens antes de gerar o PDF.');
        return;
    }

    const p = participacoesData.find(x => x.compraId === compraId);
    if (!p) {
        alert('Participação não encontrada.');
        return;
    }

    // Coletar itens selecionados com valores
    const itensPDF = [];
    disputa.itens.forEach(item => {
        const dados = getValorItem(compraId, item.numero);
        if (!dados.selecionado) return;
        const valor = dados.valor ? parseFloat(dados.valor) : (item.valorEstimado || 0);
        const qtd = dados.quantidade ? parseInt(dados.quantidade) : (item.quantidade || 1);
        itensPDF.push({
            numeroItem: item.numero,
            descricao: item.descricao || '',
            quantidade: qtd,
            unidadeMedida: item.unidadeMedida || 'UN',
            valorProposta: valor,
            totalProposta: valor * qtd,
            marca: dados.marca || '',
            modelo: dados.modelo || '',
            fabricante: dados.fabricante || '',
        });
    });

    if (itensPDF.length === 0) {
        alert('Selecione ao menos um item com valor para gerar o PDF.');
        return;
    }

    // Extrair info do compraId: {uasg:06}{modalidade:02}{numero:05}{ano:04}
    const cid = compraId.replace(/\D/g, '');
    const ano = cid.length >= 4 ? cid.slice(-4) : '';
    const numero = cid.length >= 9 ? cid.slice(-9, -4) : '';

    const licitacaoParaPDF = {
        nomeOrgao: p.orgao || '',
        codigoUnidadeCompradora: cid.length >= 6 ? cid.slice(0, 6) : '',
        numeroCompra: numero,
        ano: ano,
        sequencial: '',
        modalidadeNome: 'Pregão Eletrônico',
        objetoCompra: p.objeto || '',
        itensParaPDF: itensPDF,
    };

    await gerarPDFIndividual(licitacaoParaPDF, assinar);
}

async function gerarPDFIndividual(licitacao, assinar = false) {
    const { jsPDF } = window.jspdf;

    let fornecedor = fornecedorConfig || null;
    if (!fornecedor) {
        try {
            const response = await fetch('/api/fornecedor');
            const result = await response.json();
            if (result.success && result.data) fornecedor = result.data;
        } catch (e) { /* ignore */ }
    }

    const doc = new jsPDF();
    let y = 20;
    doc.setFont('helvetica');

    // === CABEÇALHO ===
    if (fornecedor && fornecedor.logoBase64) {
        try {
            doc.addImage(fornecedor.logoBase64, 'PNG', 15, y - 5, 45, 22);
            doc.setFontSize(18);
            doc.setTextColor(0, 51, 102);
            doc.text('PROPOSTA COMERCIAL', 130, y + 8, { align: 'center' });
            y += 25;
        } catch (e) {
            doc.setFontSize(18); doc.setTextColor(0, 51, 102);
            doc.text('PROPOSTA COMERCIAL', 105, y, { align: 'center' });
            y += 15;
        }
    } else {
        doc.setFontSize(18); doc.setTextColor(0, 51, 102);
        doc.text('PROPOSTA COMERCIAL', 105, y, { align: 'center' });
        y += 15;
    }

    doc.setDrawColor(0, 51, 102); doc.setLineWidth(0.5);
    doc.line(15, y, 195, y); y += 10;

    // === DADOS DO FORNECEDOR ===
    doc.setFontSize(11); doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'bold');
    doc.text('DADOS DO FORNECEDOR', 15, y); y += 7;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);

    if (fornecedor && fornecedor.razaoSocial) {
        doc.text(`Razão Social: ${fornecedor.razaoSocial}`, 15, y); y += 6;
        doc.text(`CNPJ: ${fornecedor.cnpj || 'N/A'}    Inscrição Estadual: ${fornecedor.inscricaoEstadual || 'N/A'}`, 15, y); y += 6;
        const enderecoCompleto = [fornecedor.endereco, fornecedor.numero ? `nº ${fornecedor.numero}` : '', fornecedor.complemento, fornecedor.bairro].filter(Boolean).join(', ');
        doc.text(`Endereço: ${enderecoCompleto || 'N/A'}`, 15, y); y += 6;
        doc.text(`Cidade: ${fornecedor.cidade || 'N/A'}    UF: ${fornecedor.uf || 'N/A'}    CEP: ${fornecedor.cep || 'N/A'}`, 15, y); y += 6;
        doc.text(`Telefone: ${fornecedor.telefone || fornecedor.celular || 'N/A'}    E-mail: ${fornecedor.email || 'N/A'}`, 15, y); y += 12;
    } else {
        doc.text('Razão Social: ________________________________________________________', 15, y); y += 6;
        doc.text('CNPJ: ___________________________ Inscrição Estadual: _________________', 15, y); y += 6;
        doc.text('Endereço: ___________________________________________________________', 15, y); y += 6;
        doc.text('Cidade: _________________________ UF: ______ CEP: ___________________', 15, y); y += 6;
        doc.text('Telefone: ______________________ E-mail: ____________________________', 15, y); y += 12;
    }

    // === DADOS DA LICITAÇÃO ===
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.text('DADOS DA LICITAÇÃO', 15, y); y += 7;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text(`Órgão: ${licitacao.nomeOrgao}`, 15, y); y += 6;
    doc.text(`UASG: ${licitacao.codigoUnidadeCompradora || 'N/A'}`, 15, y); y += 6;
    doc.text(`Número: ${licitacao.numeroCompra || 'N/A'}/${licitacao.ano}`, 15, y); y += 6;
    doc.text(`Modalidade: ${licitacao.modalidadeNome || 'Pregão Eletrônico'}`, 15, y); y += 12;

    // === TABELA DE ITENS ===
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.text('ITENS DA PROPOSTA', 15, y); y += 5;

    const tableData = licitacao.itensParaPDF.map(item => [
        item.numeroItem,
        item.descricao,
        item.marca || '-',
        item.modelo || '-',
        item.fabricante || '-',
        `${item.quantidade} ${item.unidadeMedida}`,
        formatarValorPDF(item.valorProposta),
        formatarValorPDF(item.totalProposta)
    ]);

    const totalGeral = licitacao.itensParaPDF.reduce((sum, item) => sum + item.totalProposta, 0);
    tableData.push(['', '', '', '', '', '', { content: 'TOTAL:', styles: { fontStyle: 'bold', halign: 'right' } },
                   { content: formatarValorPDF(totalGeral), styles: { fontStyle: 'bold' } }]);

    doc.autoTable({
        startY: y,
        head: [['Item', 'Descrição', 'Marca', 'Modelo', 'Fabricante', 'Qtd', 'Valor Unit.', 'Valor Total']],
        body: tableData,
        theme: 'striped',
        headStyles: { fillColor: [0, 51, 102], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
        bodyStyles: { fontSize: 7 },
        columnStyles: {
            0: { cellWidth: 10, halign: 'center' }, 1: { cellWidth: 'auto' },
            2: { cellWidth: 22 }, 3: { cellWidth: 22 }, 4: { cellWidth: 22 },
            5: { cellWidth: 18, halign: 'center' }, 6: { cellWidth: 22, halign: 'right' }, 7: { cellWidth: 22, halign: 'right' }
        },
        styles: { overflow: 'linebreak', cellPadding: 2 },
        margin: { left: 10, right: 10 }
    });

    y = doc.lastAutoTable.finalY + 15;

    // === OBSERVAÇÕES ===
    if (fornecedor && fornecedor.observacoes && fornecedor.observacoes.trim()) {
        if (y > 240) { doc.addPage(); y = 20; }
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
        doc.text('OBSERVAÇÕES', 15, y); y += 6;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
        const obsLines = doc.splitTextToSize(fornecedor.observacoes, 180);
        doc.text(obsLines, 15, y);
        y += obsLines.length * 4 + 8;
    }

    // === ASSINATURA ===
    if (y > 250) { doc.addPage(); y = 20; }
    const dataAtual = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
    doc.setFontSize(10);
    if (fornecedor && fornecedor.cidade) {
        doc.text(`${fornecedor.cidade}/${fornecedor.uf || ''}, ${dataAtual}`, 15, y);
    } else {
        doc.text(`Local e Data: _________________________, ${dataAtual}`, 15, y);
    }
    y += 20;

    doc.line(40, y, 170, y); y += 5;
    doc.setFontSize(9);
    if (fornecedor && fornecedor.representanteLegal) {
        doc.text(fornecedor.representanteLegal, 105, y, { align: 'center' }); y += 4;
        const infoRepr = [
            fornecedor.cpfRepresentante ? `CPF: ${fornecedor.cpfRepresentante}` : '',
            fornecedor.cargoRepresentante || ''
        ].filter(Boolean).join(' - ');
        doc.text(infoRepr || 'Representante Legal', 105, y, { align: 'center' });
    } else {
        doc.text('Assinatura do Representante Legal', 105, y, { align: 'center' }); y += 4;
        doc.text('(Nome, CPF e Cargo)', 105, y, { align: 'center' });
    }

    // === RODAPÉ ===
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i); doc.setFontSize(8); doc.setTextColor(128, 128, 128);
        doc.text(`Página ${i} de ${pageCount}`, 195, 290, { align: 'right' });
    }

    const nomeArquivo = `proposta_${licitacao.numeroCompra || 'orcamento'}_${licitacao.ano}_${new Date().toISOString().split('T')[0]}${assinar ? '_assinado' : ''}.pdf`;

    if (assinar) {
        const pdfBase64 = doc.output('datauristring').split(',')[1];
        try {
            const response = await fetch('/api/pdf/assinar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pdfBase64 })
            });
            const result = await response.json();
            if (result.success) {
                const link = document.createElement('a');
                link.href = 'data:application/pdf;base64,' + result.pdfAssinado;
                link.download = nomeArquivo;
                link.click();
                alert('PDF assinado gerado com sucesso!');
            } else {
                alert('Erro ao assinar: ' + result.error + '\nGerando PDF sem assinatura.');
                doc.save(nomeArquivo.replace('_assinado', ''));
            }
        } catch (error) {
            alert('Erro ao assinar PDF. Gerando versão sem assinatura.');
            doc.save(nomeArquivo.replace('_assinado', ''));
        }
    } else {
        doc.save(nomeArquivo);
        alert('PDF gerado com sucesso!');
    }
}

// ==================== CRUZAMENTO COM CATÁLOGO DE PRODUTOS ====================
// Match entre itens da licitação e produtos cadastrados na empresa.
// Cache: key = `${scopeId}:${numeroItem}` → array de produtos (top 3).
// Bota a coluna nova "Produto da empresa" na grid. Quando há match,
// clique no badge ou select aplica marca/modelo/preço no input
// correspondente da row. Sem match, botão "+ Cadastrar" abre modal.

const matchProdutosCache = new Map();
const itensOriginaisCache = new Map();  // `${scopeId}:${num}` → item PNCP/IA original (para modal cadastro)

function renderProdutoMatch(scopeId, num) {
    const key = `${scopeId}:${num}`;
    const matches = matchProdutosCache.get(key);
    if (matches === undefined) {
        return '<span class="match-loading">…</span>';
    }
    if (matches.length === 0) {
        return `<div class="produto-match-cell">
            <button type="button" class="btn-cadastrar-produto"
                    onclick="abrirCadastroProduto('${scopeId}', ${num})">+ Cadastrar</button>
        </div>`;
    }
    if (matches.length === 1) {
        const m = matches[0];
        const cls = m.score >= 100 ? 'gold' : '';
        const tooltip = `Score ${m.score} • Custo R$ ${m.precoCusto} • Venda R$ ${m.precoVenda}`;
        return `<div class="produto-match-cell">
            <span class="match-badge ${cls}" title="${tooltip}"
                  onclick="aplicarMatchProduto('${scopeId}', ${num}, ${m.id})">
                ${escapeHtml(m.sku)}
            </span>
            <span class="match-precos">${fmtValor(m.precoVenda || 0)}</span>
        </div>`;
    }
    return `<div class="produto-match-cell">
        <select class="match-select" onchange="if(this.value) aplicarMatchProduto('${scopeId}', ${num}, this.value)">
            <option value="">${matches.length} matches…</option>
            ${matches.map(m => `<option value="${m.id}">${escapeHtml(m.sku)} · R$ ${m.precoVenda}</option>`).join('')}
        </select>
    </div>`;
}

function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function carregarMatchProdutos(scopeId, itens, dadosIaPorNum) {
    if (!itens || itens.length === 0) return;
    const payload = itens.map(it => {
        const num = it.numero || it.numeroItem;
        const ia = (dadosIaPorNum && dadosIaPorNum[num]) || {};
        itensOriginaisCache.set(`${scopeId}:${num}`, { ...it, _ia: ia });
        return {
            numero: num,
            descricao: it.descricao,
            especificacoes_tecnicas: ia.especificacoes_tecnicas,
            marca_referencia: ia.marca_referencia,
        };
    });
    try {
        const r = await fetch('/api/propostas/match-produtos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itens: payload }),
        });
        const data = await r.json();
        if (!data.success) throw new Error(data.error || 'sem retorno');
        for (const m of (data.matches || [])) {
            const key = `${scopeId}:${m.numeroItem}`;
            matchProdutosCache.set(key, m.produtos || []);
            const el = document.getElementById(`match-${scopeId}-${m.numeroItem}`);
            if (el) el.innerHTML = renderProdutoMatch(scopeId, m.numeroItem);
        }
    } catch (e) {
        console.warn('[propostas] match-produtos falhou:', e.message);
        for (const it of itens) {
            const num = it.numero || it.numeroItem;
            matchProdutosCache.set(`${scopeId}:${num}`, []);
            const el = document.getElementById(`match-${scopeId}-${num}`);
            if (el) el.innerHTML = renderProdutoMatch(scopeId, num);
        }
    }
}

function aplicarMatchProduto(scopeId, num, produtoId) {
    const matches = matchProdutosCache.get(`${scopeId}:${num}`) || [];
    const p = matches.find(x => String(x.id) === String(produtoId));
    if (!p) return;
    const marcaEl = document.getElementById(`marca-${scopeId}-${num}`);
    const modeloEl = document.getElementById(`modelo-${scopeId}-${num}`);
    const valEl = document.getElementById(`val-${scopeId}-${num}`);
    if (marcaEl && p.marca) { marcaEl.value = p.marca; atualizarExtra(scopeId, num, 'marca', p.marca); }
    if (modeloEl && p.modelo) { modeloEl.value = p.modelo; atualizarExtra(scopeId, num, 'modelo', p.modelo); }
    if (valEl && p.precoVenda && !valEl.value) {
        valEl.value = p.precoVenda;
        atualizarValor(scopeId, num, p.precoVenda);
    }
    const tooltip = `Vinculado • Custo R$ ${p.precoCusto} • Venda R$ ${p.precoVenda}`;
    const cell = document.getElementById(`match-${scopeId}-${num}`);
    if (cell) {
        cell.innerHTML = `<div class="produto-match-cell">
            <span class="match-badge" title="${tooltip}">✓ ${escapeHtml(p.sku)}</span>
            <span class="match-precos">${fmtValor(p.precoVenda || 0)}</span>
        </div>`;
    }
}

let _cadastroContext = null;

function abrirCadastroProduto(scopeId, num) {
    const item = itensOriginaisCache.get(`${scopeId}:${num}`) || {};
    const ia = item._ia || {};
    _cadastroContext = { scopeId, num };

    const desc = (ia.descricao || item.descricao || '').slice(0, 200);
    const sku = gerarSkuSugerido(desc);
    const sugestao = ia.sugestao_cotacao || '';
    const primeiraSug = sugestao.split(/[;|]/)[0] || '';
    const marca = ia.marca_referencia || extrairMarca(primeiraSug);
    const modelo = extrairModelo(primeiraSug, marca);

    document.getElementById('formProd_descricao').value = desc;
    document.getElementById('formProd_sku').value = sku;
    document.getElementById('formProd_unidade').value = (item.unidadeMedida || 'UN').slice(0, 8);
    document.getElementById('formProd_marca').value = marca || '';
    document.getElementById('formProd_modelo').value = modelo || '';
    document.getElementById('formProd_custo').value = item.valorEstimado || 0;
    document.getElementById('formProd_venda').value = '';
    document.getElementById('formProd_obs').value = ia.especificacoes_tecnicas || '';

    document.getElementById('modalCadastroProduto').classList.add('open');
}

function fecharCadastroProduto() {
    document.getElementById('modalCadastroProduto').classList.remove('open');
    _cadastroContext = null;
}

function gerarSkuSugerido(desc) {
    const base = (desc || 'PROD').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12);
    const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `${base}-${rnd}`;
}

function extrairMarca(s) {
    if (!s) return '';
    // Pega a primeira palavra "marca-like" (sem espaço, capitalizada ou ALLCAPS)
    const m = s.trim().match(/^([A-Za-zÀ-ÿ][\wÀ-ÿ\-]+)/);
    return m ? m[1] : '';
}

function extrairModelo(s, marca) {
    if (!s) return '';
    let resto = marca ? s.replace(marca, '').trim() : s.trim();
    // Para na primeira palavra que parece descrição (em parêntese, vírgula etc)
    const m = resto.match(/^([^,(;]{1,40})/);
    return (m ? m[1] : '').trim();
}

async function salvarNovoProdutoMatch() {
    if (!_cadastroContext) return;
    const payload = {
        sku: document.getElementById('formProd_sku').value.trim(),
        descricao: document.getElementById('formProd_descricao').value.trim(),
        unidade: document.getElementById('formProd_unidade').value.trim() || 'UN',
        marca: document.getElementById('formProd_marca').value.trim() || null,
        modelo: document.getElementById('formProd_modelo').value.trim() || null,
        precoCusto: parseFloat(document.getElementById('formProd_custo').value) || 0,
        precoVenda: parseFloat(document.getElementById('formProd_venda').value) || 0,
        observacoes: document.getElementById('formProd_obs').value.trim() || null,
    };
    if (!payload.sku || !payload.descricao) {
        alert('SKU e Descrição são obrigatórios.');
        return;
    }
    try {
        const r = await fetch('/api/propostas/cadastrar-produto', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await r.json();
        if (!data.success) {
            alert('Falha: ' + (data.error || 'erro desconhecido'));
            return;
        }
        const { scopeId, num } = _cadastroContext;
        // Adiciona o produto recém-criado no cache de matches da row
        const novoProduto = {
            ...data.produto,
            score: 999, // forçar como melhor match
        };
        matchProdutosCache.set(`${scopeId}:${num}`, [novoProduto]);
        const el = document.getElementById(`match-${scopeId}-${num}`);
        if (el) el.innerHTML = renderProdutoMatch(scopeId, num);
        aplicarMatchProduto(scopeId, num, novoProduto.id);
        fecharCadastroProduto();
    } catch (e) {
        alert('Erro: ' + e.message);
    }
}

// Hook nas funções existentes: após renderizar itens, dispara match em background.
// Monkey-patch para chamar carregarMatchProdutos sem alterar carregarItens
// e renderizarInteresses originais.
(function hookMatch() {
    const origCarregar = window.carregarItens;
    if (typeof origCarregar === 'function') {
        window.carregarItens = async function(compraId) {
            await origCarregar.apply(this, arguments);
            const disp = (typeof disputasData !== 'undefined') ? disputasData.get(compraId) : null;
            const itens = disp ? disp.itens : [];
            if (itens.length > 0) {
                const dadosIa = await carregarDadosIaParaInteresse(compraId);
                carregarMatchProdutos(compraId, itens, dadosIa);
            }
        };
    }
    const origRenderInteresses = window.renderizarInteresses;
    if (typeof origRenderInteresses === 'function') {
        window.renderizarInteresses = function() {
            origRenderInteresses.apply(this, arguments);
            // Para cada licitação de interesse já renderizada, dispara match
            const lista = (typeof interessesData !== 'undefined') ? interessesData : [];
            for (const lic of lista) {
                const ikey = interesseKey(lic);
                const scopeId = lic.compraId || ikey;
                if (lic.itens && lic.itens.length > 0) {
                    carregarDadosIaParaInteresse(scopeId).then(dadosIa => {
                        carregarMatchProdutos(scopeId, lic.itens, dadosIa);
                    });
                }
            }
        };
    }
})();

// Para interesses, carrega análise IA pra enriquecer match com marca_referencia/specs.
// Tenta primeiro o map de interesses (que tem cnpj/ano/seq).
async function carregarDadosIaParaInteresse(compraIdOrPrefix) {
    try {
        const ids = (typeof resolveIdsLicitacao === 'function') ? resolveIdsLicitacao(compraIdOrPrefix) : null;
        if (!ids || !ids.cnpj || !ids.ano || !ids.sequencial) return {};
        const r = await fetch(`/api/licitacoes/${ids.cnpj}/${ids.sequencial}/${ids.ano}/analise`);
        const data = await r.json();
        const itens = (data.analise && data.analise.itens_destaque) || [];
        const porNum = {};
        for (const it of itens) {
            if (it.numero != null) porNum[it.numero] = it;
        }
        return porNum;
    } catch { return {}; }
}

// ==================== INIT ====================

document.addEventListener('DOMContentLoaded', () => {
    carregarFornecedorConfig();
    atualizarTokenStatus();
    carregarParticipacoes().then(() => mostrarInteresses());
    setInterval(atualizarTokenStatus, 30000);
});
