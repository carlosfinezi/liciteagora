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
            div.innerHTML = `<span class="token-err">Sem token</span>`;
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
    interessesData.forEach(lic => {
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
            situacao: part?.situacao || '',
            faseCompra: part?.faseCompra || '',
            etapa: part?.etapa || '',
            dataSessao: lic.dataEncerramentoProposta || part?.dataSessao || '',
            semCompraId: !lic.compraId || naoComprasnet,
            naoComprasnet,
            sistemaOrigem,
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
    const comCompraId = interessesData.filter(l => l.compraId && !l.compraId.startsWith('NAO_COMPRASNET:')).length;
    const naoComprasnet = interessesData.filter(l => l.compraId?.startsWith('NAO_COMPRASNET:')).length;
    const pendentesCompraId = interessesData.length - comCompraId - naoComprasnet;
    document.getElementById('statsInfo').innerHTML =
        `${interessesData.length} interesses | ${comCompraId} Comprasnet | ${naoComprasnet ? naoComprasnet + ' estadual/municipal | ' : ''}${pendentesCompraId} pendentes`;
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

        let allParticipacoes = [];
        if (pResp) try { allParticipacoes = ((await pResp.json()).data) || []; } catch (e) {}

        if (dResp) try {
            const dResult = await dResp.json();
            if (dResult.disputas) dResult.disputas.forEach(d => disputasData.set(d.compraId, d));
        } catch (e) {}

        // 2. Renderizar imediatamente com o que temos
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
    const situacoes = new Set();
    participacoesData.forEach(p => {
        if (p.situacao) situacoes.add(p.situacao);
    });
    const select = document.getElementById('filtroSituacao');
    select.innerHTML = '<option value="">Todas situações</option>';
    Array.from(situacoes).sort().forEach(s => {
        select.innerHTML += `<option value="${s}">${formatarSituacao(s)} (${s})</option>`;
    });
    // PD (Em Disputa) como padrão se existir
    if (situacoes.has('PD')) {
        select.value = 'PD';
    }
    aplicarFiltros();
}

function aplicarFiltros() {
    const texto = document.getElementById('filtroTexto').value.toLowerCase().trim();
    const situacao = document.getElementById('filtroSituacao').value;

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
        if (situacao && p.situacao !== situacao) visivel = false;

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
        // Interesses não têm campo situacao do Comprasnet, ignorar filtro de situação
        if (situacao) visivel = false;

        panel.style.display = visivel ? '' : 'none';
        if (visivel) visiveis++;
    });

    const resultado = document.getElementById('filtroResultado');
    resultado.textContent = (texto || situacao) ? `Exibindo ${visiveis} de ${total}` : '';
}

function limparFiltros() {
    document.getElementById('filtroTexto').value = '';
    document.getElementById('filtroSituacao').value = '';
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
                        ${compraIdDisplay}
                        ${p.situacao ? `<span class="badge-situacao badge-sit-${(p.situacao || '').toUpperCase()}">${situacaoLabel}</span>` : ''}
                        ${faseLabel ? `<span class="badge-fase">${faseLabel}</span>` : ''}
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
                             <button class="btn btn-sm btn-outline" onclick="carregarItens('${p.compraId}')">
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
            <div class="item-header-row">
                <div></div>
                <div>Item / Descrição</div>
                <div>Melhor R$</div>
                <div>Nosso R$</div>
                <div>Valor Proposta</div>
                <div>Marca / Modelo</div>
                <div>Situação</div>
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
            <div class="item-row ${dados.selecionado ? 'selecionado' : ''}" id="row-${compraId}-${num}">
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
                <div class="item-valor">${item.melhorValor != null ? fmtValor(item.melhorValor) : '-'}</div>
                <div class="item-valor ${sit === 'G' ? 'valor-ganhando' : sit === 'P' ? 'valor-participando' : ''}">
                    ${item.nossoValor != null ? fmtValor(item.nossoValor) : '-'}
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
                <div>
                    <span class="badge-sit badge-sit-${sit}">${sitLabel}</span>
                </div>
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
        const resp = await fetch(`/api/proposta/itens-compra/${compraId}`);
        const result = await resp.json();

        if (result.success && result.itens?.length > 0) {
            disputasData.set(compraId, {
                compraId,
                itens: result.itens,
                orgao: result.orgao || '',
                objeto: result.objeto || '',
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
            container.innerHTML = `<div class="empty-itens">
                ${result.error || 'Nenhum item encontrado'}
                <br><small>Fonte: ${result.fonte || 'api'}</small>
                <br><button class="btn btn-sm btn-outline" style="margin-top:8px;" onclick="participarEListar('${compraId}')">
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
    atualizarResumo();
}

function atualizarExtra(compraId, numero, campo, valor) {
    setValorItem(compraId, numero, { [campo]: valor });
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

    // Declarações vêm da config do fornecedor (fornecedor.html)
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
    const extras = interessesData.filter(lic => !lic.compraId || !participacoesIds.has(lic.compraId));

    if (extras.length === 0) return;

    const section = document.getElementById('interessesSection');
    section.style.display = 'block';
    document.getElementById('interessesBadge').textContent = extras.length;

    if (participacoesData.length > 0) {
        document.getElementById('separadorSections').style.display = 'block';
    }

    renderizarInteresses();
}

function toggleInteresses() {
    interessesVisiveis = !interessesVisiveis;
    document.getElementById('interessesContainer').style.display = interessesVisiveis ? '' : 'none';
    document.getElementById('interessesToggle').textContent = interessesVisiveis ? '▼' : '▶';
}

function interesseKey(lic) {
    return `interesse-${lic.cnpj}-${lic.ano}-${lic.sequencial}`;
}

function renderizarInteresses() {
    const container = document.getElementById('interessesContainer');
    container.innerHTML = '';

    interessesData.forEach(lic => {
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
                        <span class="badge-interesse">Interesse</span>
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
            <div class="item-header-row">
                <div></div>
                <div>Item / Descrição</div>
                <div>Ref R$</div>
                <div>Qtde</div>
                <div>Valor Proposta</div>
                <div>Marca / Modelo</div>
                <div>Unid</div>
            </div>
    `;

    itens.forEach(item => {
        const num = item.numero;
        const dados = getValorItem(itemPrefix, num);

        html += `
            <div class="item-row ${dados.selecionado ? 'selecionado' : ''}" id="row-${itemPrefix}-${num}">
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
                <div class="item-valor">${item.quantidade || 1}</div>
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
            </div>
        `;
    });

    html += '</div>';
    return html;
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
        itensPDF.push({
            numeroItem: item.numero,
            descricao: item.descricao || '',
            quantidade: item.quantidade || 1,
            unidadeMedida: item.unidadeMedida || 'UN',
            valorProposta: valor,
            totalProposta: valor * (item.quantidade || 1),
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

// ==================== INIT ====================

document.addEventListener('DOMContentLoaded', () => {
    carregarFornecedorConfig();
    atualizarTokenStatus();
    carregarParticipacoes().then(() => mostrarInteresses());
    setInterval(atualizarTokenStatus, 30000);
});
